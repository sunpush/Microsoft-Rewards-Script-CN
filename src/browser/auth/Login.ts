import { LoginSession } from './LoginSession'
import { LoginStateDetector, LOGIN_SELECTORS, type LoginState, type LoginStateSnapshot } from './LoginStateDetector'
import { ghostClick } from '../GhostClick'
import { browserTimeout } from '../BrowserTiming'
import { URLs, REWARDS_BASE_URL } from '../../constants/urls'
import type { Page } from 'patchright'
import type { BotContext } from '../../core/BotContext'
import { unknownPageDiagnostic } from '../../util/ErrorDiagnostic'
import { suspendMediaBlocking } from '../MediaBlocker'

import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { EmailLogin } from './methods/EmailLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { TotpLogin } from './methods/Totp2FALogin'
import { CodeLogin } from './methods/GetACodeLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'
import { canPromptForInput } from './methods/LoginUtils'

import type { Account } from '../../core/Account'

type SignInMethodOption = {
    index: number
    selector: string
    label: string
    signature: string
}

type SignInMethodType = 'PASSWORD' | 'AUTHENTICATOR' | 'EMAIL' | 'PASSKEY' | 'TOTP' | 'UNKNOWN'

export class Login {
    private lastDetectedState = ''
    emailLogin: EmailLogin
    passwordlessLogin: PasswordlessLogin
    totp2FALogin: TotpLogin
    codeLogin: CodeLogin
    recoveryLogin: RecoveryLogin

    private readonly capturedUnknownUrls = new Set<string>()
    private signInMethodsLogged = false
    private passwordlessMethodSelected = false

    private readonly selectors = LOGIN_SELECTORS

    constructor(private bot: BotContext) {
        this.emailLogin = new EmailLogin(this.bot)
        this.passwordlessLogin = new PasswordlessLogin(this.bot)
        this.totp2FALogin = new TotpLogin(this.bot)
        this.codeLogin = new CodeLogin(this.bot)
        this.recoveryLogin = new RecoveryLogin(this.bot)
    }

    async login(page: Page, account: Account, sessionOnly = false) {
        let removeFidoRoute: (() => Promise<void>) | undefined
        try {
            suspendMediaBlocking(this.bot, page.context())
            this.capturedUnknownUrls.clear()
            this.signInMethodsLogged = false
            this.passwordlessMethodSelected = false
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始登录流程')

            await page
                .goto(URLs.rewards.userLogin, {
                    waitUntil: 'domcontentloaded'
                })
                .catch(() => undefined)
            await this.bot.utils.wait(2000)
            await this.bot.browser.utils.reloadNetworkError(page)
            removeFidoRoute = await this.bot.browser.utils.blockPasskeys(page)

            const maxIterations = 25
            let iteration = 0
            let loggedIn = false
            let previousState: LoginState = 'UNKNOWN'
            let sameStateCount = 0

            const deadline = Date.now() + 10 * 60 * 1000
            while (iteration < maxIterations) {
                this.bot.signal.throwIfAborted()
                if (Date.now() > deadline) throw new Error('Login exceeded its 10-minute deadline')
                if (page.isClosed()) throw new Error('Page closed unexpectedly')

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `状态检测迭代 ${iteration}/${maxIterations}`)

                const detected = await this.detectCurrentState(page)
                if (page.url() !== detected.url) continue
                const { state } = detected
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `当前状态：${state}`)

                if (state !== previousState && previousState !== 'UNKNOWN') {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `状态切换：${previousState} → ${state}`)
                }

                if (
                    state === previousState &&
                    state !== 'LOGGED_IN' &&
                    state !== 'UNKNOWN' &&
                    state !== 'PAGE_TRANSITION'
                ) {
                    sameStateCount++
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN',
                        `同一状态已连续出现 ${sameStateCount}/4 次，当前状态为 "${state}"`
                    )
                    if (sameStateCount >= 4) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            `已在状态 "${state}" 中卡住 4 次循环，正在刷新页面`
                        )
                        await page.reload({ waitUntil: 'domcontentloaded' })
                        await this.bot.utils.wait(3000)
                        sameStateCount = 0
                        previousState = 'UNKNOWN'
                        continue
                    }
                } else {
                    sameStateCount = 0
                }
                previousState = state

                if (state === 'LOGGED_IN') {
                    loggedIn = true
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '登录成功')
                    break
                }

                const shouldContinue = await this.handleState(detected, page, account)
                if (!shouldContinue) {
                    throw new Error(`Login failed or aborted at state: ${state}`)
                }

                await this.bot.utils.wait(1000)
            }

            if (!loggedIn) {
                throw new Error('Login timeout: exceeded maximum iterations')
            }

            await removeFidoRoute()
            removeFidoRoute = undefined
            await this.finalizeLogin(page, account, sessionOnly)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `发生致命错误：${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        } finally {
            await removeFidoRoute?.().catch(() => undefined)
        }
    }

    private async detectCurrentState(page: Page): Promise<LoginStateSnapshot> {
        const snapshot = await new LoginStateDetector(this.bot, this.passwordlessMethodSelected).detect(page)
        const url = new URL(snapshot.url)
        const observation = `${snapshot.state} | page=${url.hostname}${url.pathname}`
        if (observation !== this.lastDetectedState) {
            this.lastDetectedState = observation
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', observation)
        }
        return snapshot
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .locator(selector)
            .first()
            .isVisible()
            .catch(() => false)
    }

    private normalizeSignInText(value: string): string {
        return value.replace(/\s+/g, ' ').trim()
    }

    private sanitizeSignInLabel(value: string): string {
        return this.normalizeSignInText(value)
            .replace(/[\w.+*-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
            .replace(/\+?\d[\d\s().*-]{5,}\d/g, '<phone>')
    }

    private async getSignInMethodOptions(page: Page): Promise<SignInMethodOption[]> {
        const tiles = page.locator(this.selectors.signInTile)
        const count = await tiles.count().catch(() => 0)
        const options = await Promise.all(
            Array.from({ length: count }, async (_, index): Promise<SignInMethodOption | null> => {
                const tile = tiles.nth(index)
                if (!(await tile.isVisible().catch(() => false))) return null

                const metadata = await tile
                    .evaluate(element => {
                        const elements = [element, ...Array.from(element.querySelectorAll('*'))]
                        const structuralAttributeNames = new Set([
                            'id',
                            'name',
                            'src',
                            'data-testid',
                            'data-value',
                            'data-bind',
                            'd'
                        ])
                        const accessibleText = elements
                            .flatMap(node => ['aria-label', 'title', 'alt'].map(name => node.getAttribute(name) ?? ''))
                            .filter(Boolean)
                            .join(' ')
                        const structuralAttributes = elements
                            .flatMap(node =>
                                Array.from(node.attributes)
                                    .filter(attribute => structuralAttributeNames.has(attribute.name))
                                    .map(attribute => `${attribute.name}=${attribute.value}`)
                            )
                            .join(' ')

                        return {
                            text: element.textContent ?? '',
                            accessibleText,
                            structuralAttributes
                        }
                    })
                    .catch(() => null)

                if (!metadata) return null

                const label = this.normalizeSignInText(`${metadata.text} ${metadata.accessibleText}`)
                const signature = this.normalizeSignInText(metadata.structuralAttributes).toLowerCase()

                return {
                    index,
                    selector: `${this.selectors.signInTile} >> nth=${index}`,
                    label: label || `Sign-in option ${index + 1}`,
                    signature
                }
            })
        )

        return options.filter((option): option is SignInMethodOption => option !== null)
    }

    private classifySignInMethod(option: SignInMethodOption): SignInMethodType {
        const signature = option.signature

        // Sign in another way - classify method tiles from structural signatures, not translated labels
        if (signature.includes('m5.25 4h13.5a3.25') || signature.includes('picker_verify_email')) return 'EMAIL'
        if (signature.includes('m11.78 10.22a.75')) return 'PASSWORD'
        // Known passkey/security-key SVG signature keeps it out of the Authenticator fallback
        if (/picker_fido|passkey|fido|m18 16\.66a3\.51/.test(signature)) return 'PASSKEY'
        if (/phone[\s_-]*app[\s_-]*otp|\btotp\b/.test(signature)) return 'TOTP'
        // Known Remote NGC/mobile-app SVG signature identifies Microsoft Authenticator language-independently
        if (
            /remote[\s_-]*ngc|picker_remote_ngc|phone[\s_-]*app[\s_-]*notification|push[\s_-]*notification|m15\.75 2c16\.99 2 18 3/.test(
                signature
            )
        ) {
            return 'AUTHENTICATOR'
        }

        return 'UNKNOWN'
    }

    private async clickSignInMethodOption(page: Page, option: SignInMethodOption): Promise<boolean> {
        const clicked = await this.bot.browser.utils.click(page, option.selector)
        if (clicked) return true

        return ghostClick(
            page,
            page.locator(this.selectors.signInTile).nth(option.index),
            browserTimeout(this.bot),
            this.bot.signal
        )
            .then(() => true)
            .catch(() => false)
    }

    private logAvailableSignInMethods(options: SignInMethodOption[]): void {
        if (this.signInMethodsLogged) return
        this.signInMethodsLogged = true
        if (options.length === 0) return

        const labels = options.map(option => this.sanitizeSignInLabel(option.label))
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `可用的登录方式：${labels.join(' | ')}`)
    }

    private async waitForIdle(page: Page, note: string, timeout = 5000): Promise<void> {
        await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `文档就绪等待超时：${note}`)
        })
    }

    private async tryClick(page: Page, selector: string, label: string, timeout = 2000): Promise<boolean> {
        const found = await page.waitForSelector(selector, { state: 'visible', timeout }).catch(() => null)
        if (!found) return false

        const clicked = await this.bot.browser.utils.click(page, selector)
        if (!clicked) return false

        await this.waitForIdle(page, `点击 ${label} 之后`)
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `已点击 ${label}`)
        return true
    }

    private async handleState(
        { state, url: detectedUrl }: LoginStateSnapshot,
        page: Page,
        account: Account
    ): Promise<boolean> {
        if (page.url() !== detectedUrl) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'HANDLE-STATE',
                '状态检测后页面已发生变化；正在重新检测'
            )
            return true
        }
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `正在处理状态：${state}`)

        switch (state) {
            case 'ACCOUNT_LOCKED': {
                const msg = '该账号已被锁定！请从配置中移除并重启！'
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                throw new Error(msg)
            }

            case 'ERROR_ALERT': {
                const alertEl = page.locator(this.selectors.errorAlert)
                const errorMsg = await alertEl.innerText().catch(() => 'Unknown Error')
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', `账号错误：${errorMsg}`)
                throw new Error(`Microsoft login error: ${errorMsg}`)
            }

            case 'LOGGED_IN':
                return true

            case 'EMAIL_INPUT': {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '正在输入邮箱')
                const result = await this.emailLogin.enterEmail(page, account.email)
                if (result !== 'ok') return false
                await this.waitForIdle(page, '输入邮箱之后')
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '邮箱输入成功')
                return true
            }

            // Enter password - use it only when Microsoft actually presents the password page
            case 'PASSWORD_INPUT': {
                if (!account.password) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN',
                        '检测到密码输入框，但未配置密码；正在返回登录方式选择'
                    )
                    if (await this.tryClick(page, this.selectors.backButton, '返回按钮')) return true

                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        '未配置密码，也没有办法返回登录方式选择'
                    )
                    return false
                }

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '正在输入密码')
                const result = await this.emailLogin.enterPassword(page, account.password)
                if (result === 'error') return false
                await this.waitForIdle(page, '输入密码之后')
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '密码输入成功')
                return true
            }

            // Generic alternative-method footer - open the method picker before choosing a credential
            case 'FOOTER_ACTION': {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '正在打开其他登录方式')
                const clicked = await this.bot.browser.utils.click(page, this.selectors.footerAction)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法打开其他登录方式')
                    return false
                }
                this.passwordlessMethodSelected = false
                await this.waitForIdle(page, '点击登录页脚操作之后')
                return true
            }

            // Get a sign-in request - keep the primary Authenticator action when footer is a proof fallback
            case 'PASSWORDLESS_SEND_CODE': {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '继续使用主要登录方式')
                const clicked = await this.bot.browser.utils.click(page, this.selectors.primaryButton)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法继续使用主要登录方式')
                    return false
                }
                await this.waitForIdle(page, '执行主要登录操作之后')
                return true
            }

            // Sign in another way - prefer offered password, then Authenticator, then interactive email code
            case 'SIGN_IN_METHOD_PICKER': {
                const options = await this.getSignInMethodOptions(page)
                this.logAvailableSignInMethods(options)

                const methods = options.map(option => ({ option, type: this.classifySignInMethod(option) }))
                const passwordOption = methods.find(method => method.type === 'PASSWORD')?.option
                const authenticatorOption = methods.find(method => method.type === 'AUTHENTICATOR')?.option
                const emailOption = methods.find(method => method.type === 'EMAIL')?.option

                if (account.password && passwordOption) {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '可以使用密码登录；正在选择该方式')
                    this.passwordlessMethodSelected = false

                    if (!(await this.clickSignInMethodOption(page, passwordOption))) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法选择密码登录方式')
                        return false
                    }

                    await this.waitForIdle(page, '选择密码登录方式之后')
                    return true
                }

                const passwordlessOptionOldFound = await this.checkSelector(page, this.selectors.passwordlessOptionOld)
                if (authenticatorOption || passwordlessOptionOldFound) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '正在选择 Microsoft Authenticator 登录')
                    this.passwordlessMethodSelected = true

                    const clicked = authenticatorOption
                        ? await this.clickSignInMethodOption(page, authenticatorOption)
                        : await this.bot.browser.utils.click(page, this.selectors.passwordlessOptionOld)

                    if (!clicked) {
                        this.passwordlessMethodSelected = false
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法选择 Microsoft Authenticator')
                        return false
                    }

                    await this.waitForIdle(page, '选择 Microsoft Authenticator 之后')

                    const passwordlessChallengeVisible =
                        (await this.checkSelector(page, this.selectors.passwordlessCheck)) ||
                        (await this.checkSelector(page, this.selectors.passwordlessNumber))

                    if (
                        !passwordlessChallengeVisible &&
                        (await this.checkSelector(page, this.selectors.primaryButton))
                    ) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '正在发送 Microsoft Authenticator 请求')
                        const confirmed = await this.bot.browser.utils.click(page, this.selectors.primaryButton)
                        if (!confirmed) {
                            this.passwordlessMethodSelected = false
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'LOGIN',
                                '无法发送 Microsoft Authenticator 请求'
                            )
                            return false
                        }
                        await this.waitForIdle(page, '发送 Microsoft Authenticator 请求之后')
                    }

                    return true
                }

                const emailIconOldFound = await this.checkSelector(page, this.selectors.emailIconOld)
                if (emailOption || emailIconOldFound) {
                    if (!canPromptForInput()) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'LOGIN',
                            '没有可用的非交互式登录方式；邮箱验证码回退需要交互式 stdin'
                        )
                        return false
                    }

                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '正在选择邮箱验证码登录')
                    this.passwordlessMethodSelected = false

                    const clicked = emailOption
                        ? await this.clickSignInMethodOption(page, emailOption)
                        : await this.bot.browser.utils.click(page, this.selectors.emailIconOld)

                    if (!clicked) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法选择邮箱验证码登录方式')
                        return false
                    }

                    await this.waitForIdle(page, '选择邮箱登录方式之后')
                    await this.codeLogin.handle(page)
                    return true
                }

                const ignoredMethods = methods
                    .map(method => method.type)
                    .filter(type => type === 'PASSKEY' || type === 'TOTP' || type === 'UNKNOWN')

                this.bot.logger.error(
                    this.bot.isMobile,
                    'LOGIN',
                    `没有可用的登录方式${ignoredMethods.length ? `；已忽略=${ignoredMethods.join(',')}` : ''}`
                )
                return false
            }

            // Recovery email confirmation
            case 'RECOVERY_EMAIL_INPUT': {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '检测到恢复邮箱输入框')
                await this.waitForIdle(page, '在恢复邮箱页面')
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '正在启动恢复邮箱处理器')
                await this.recoveryLogin.handle(page, account?.recoveryEmail)
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '恢复邮箱处理器已成功完成')
                return true
            }

            // Verify your email - identical footer actions are validated by their resulting state, not position
            case 'EMAIL_VERIFICATION_INPUT': {
                if (!account.password) {
                    if (!canPromptForInput()) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'LOGIN',
                            '邮箱验证需要已配置的密码或交互式 stdin'
                        )
                        return false
                    }

                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '检测到邮箱验证输入框')
                    await this.codeLogin.handle(page)
                    return true
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN',
                    '检测到邮箱验证输入框；正在检查其他可用方式'
                )
                await this.waitForIdle(page, '在邮箱验证页面')

                const waitForState = async (accept: (state: LoginState) => boolean): Promise<LoginState | null> => {
                    const deadline = Date.now() + browserTimeout(this.bot)

                    while (Date.now() < deadline) {
                        this.bot.signal.throwIfAborted()

                        const detected = await this.detectCurrentState(page)
                        if (page.url() === detected.url && accept(detected.state)) return detected.state

                        await this.bot.utils.wait(100)
                    }

                    return null
                }

                const footerSelector = `${this.selectors.footerAction}:visible`
                const footerCount = await page
                    .locator(footerSelector)
                    .count()
                    .catch(() => 0)

                for (let index = 0; index < footerCount; index++) {
                    const selector = `${footerSelector} >> nth=${index}`
                    if (!(await this.bot.browser.utils.click(page, selector))) continue

                    const nextState = await waitForState(
                        state =>
                            state !== 'EMAIL_VERIFICATION_INPUT' && state !== 'UNKNOWN' && state !== 'PAGE_TRANSITION'
                    )
                    if (!nextState) continue

                    if (nextState === 'PASSWORD_INPUT') {
                        this.passwordlessMethodSelected = false
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '已选择密码登录选项')
                        return true
                    }

                    if (nextState === 'SIGN_IN_METHOD_PICKER') {
                        this.passwordlessMethodSelected = false
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '已打开登录方式选择界面')
                        return true
                    }

                    // Let the main login loop handle other recognized sign-in states
                    if (nextState !== 'OTP_CODE_ENTRY') return true

                    if (!(await this.tryClick(page, this.selectors.backButton, '返回按钮'))) break

                    // Fluent views can change after the document is already ready
                    const returned = await waitForState(state => state === 'EMAIL_VERIFICATION_INPUT')
                    if (!returned) break
                }

                if (canPromptForInput()) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '正在回退到交互式邮箱验证')
                    await this.codeLogin.handle(page)
                    return true
                }

                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '未找到可用的邮箱验证替代方式')
                return false
            }

            case 'CHROMEWEBDATA_ERROR': {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '检测到 chromewebdata 错误，正在尝试恢复')
                for (const url of [REWARDS_BASE_URL, URLs.auth.loginLive]) {
                    this.bot.signal.throwIfAborted()
                    try {
                        const response = await page.goto(url, {
                            waitUntil: 'domcontentloaded',
                            timeout: browserTimeout(this.bot, 'navigation')
                        })
                        if (page.url().startsWith('chrome-error:') || (response && !response.ok()))
                            throw new Error(
                                `Recovery navigation failed | status=${response?.status() ?? 'unavailable'}`
                            )
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN',
                            '恢复导航已完成；正在检查登录状态'
                        )
                        return true
                    } catch (error) {
                        this.bot.signal.throwIfAborted()
                        if (url === URLs.auth.loginLive) throw error
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            `恢复导航失败；正在尝试 login.live.com | ${error instanceof Error ? error.message : String(error)}`
                        )
                    }
                }
                return false
            }

            case '2FA_TOTP': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '需要 TOTP 双重验证')
                await this.totp2FALogin.handle(page, account.totpSecret)
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'TOTP 双重验证处理器已成功完成')
                return true
            }

            // Stay signed in / KMSI confirmation
            case 'KMSI_PROMPT': {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '正在接受"保持登录状态"提示')
                const clicked = await this.bot.browser.utils.click(page, this.selectors.primaryButton)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法接受"保持登录状态"提示')
                    return false
                }
                await this.waitForIdle(page, '接受"保持登录状态"提示之后')
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '已接受"保持登录状态"提示')
                return true
            }

            // Passkey prompt/error - skip back to a supported sign-in method
            case 'PASSKEY_VIDEO':
            case 'PASSKEY_ERROR': {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '正在跳过通行密钥提示')
                const clicked = await this.bot.browser.utils.click(page, this.selectors.secondaryButton)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法跳过通行密钥提示')
                    return false
                }
                await this.waitForIdle(page, '跳过通行密钥提示之后')
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '已跳过通行密钥提示')
                return true
            }

            // Microsoft Authenticator approval/number challenge
            case 'LOGIN_PASSWORDLESS': {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '正在处理无密码验证')
                await this.passwordlessLogin.handle(page)
                this.passwordlessMethodSelected = false
                await this.waitForIdle(page, '无密码验证之后')
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '无密码验证已成功完成')
                return true
            }

            // Enter your code - prefer its alternate-method footer before Back to avoid an email-code loop
            case 'OTP_CODE_ENTRY': {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN',
                    '检测到 OTP 验证码输入页；正在尝试其他可用的登录方式'
                )

                if (await this.checkSelector(page, this.selectors.footerAction)) {
                    const clicked = await this.bot.browser.utils.click(page, this.selectors.footerAction)
                    if (clicked) {
                        await this.waitForIdle(page, '执行 OTP 替代登录操作之后')

                        const stillOnOtp = await this.checkSelector(page, this.selectors.otpCodeEntry)
                        if (!stillOnOtp) {
                            const methodPickerVisible =
                                (await this.checkSelector(page, this.selectors.signInTile)) ||
                                (await this.checkSelector(page, this.selectors.passwordlessOptionOld)) ||
                                (await this.checkSelector(page, this.selectors.emailIconOld))
                            const passwordlessLandingVisible =
                                (await this.checkSelector(page, this.selectors.passwordlessCheck)) ||
                                (await this.checkSelector(page, this.selectors.passwordlessNumber)) ||
                                ((await this.checkSelector(page, this.selectors.identityBanner)) &&
                                    (await this.checkSelector(page, this.selectors.primaryButton)))

                            this.passwordlessMethodSelected = passwordlessLandingVisible
                            this.bot.logger.debug(
                                this.bot.isMobile,
                                'LOGIN',
                                methodPickerVisible
                                    ? '已返回登录方式选择'
                                    : passwordlessLandingVisible
                                      ? '已切换到 Microsoft Authenticator 登录'
                                      : '已从邮箱验证码验证切换'
                            )
                            return true
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN',
                            'OTP 页脚操作未离开验证码输入页；正在回退到"返回"按钮'
                        )
                    }
                }

                this.passwordlessMethodSelected = false
                if (!(await this.tryClick(page, this.selectors.backButton, '返回按钮'))) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '在 OTP 页面未找到可用的替代操作')
                    return false
                }

                return true
            }

            case 'PAGE_TRANSITION':
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '登录重定向仍在进行中，正在等待')
                return true

            case 'UNKNOWN': {
                const rawUrl = detectedUrl
                const url = new URL(rawUrl)
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `未知状态，位于 ${url.hostname}${url.pathname}，正在等待`
                )

                if (this.bot.config.errorDiagnostics && !this.capturedUnknownUrls.has(rawUrl)) {
                    this.capturedUnknownUrls.add(rawUrl)
                    await unknownPageDiagnostic(page, {
                        platform: this.bot.isMobile ? 'mobile' : 'desktop'
                    })
                }
                return true
            }

            default:
                this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `未处理的状态：${state}，继续执行`)
                return true
        }
    }

    private finalizeLogin(page: Page, account: Account, sessionOnly: boolean): Promise<void> {
        return new LoginSession(this.bot, async (target, selected) => {
            const detected = await this.detectCurrentState(target)
            if (target.url() === detected.url && !(await this.handleState(detected, target, selected)))
                throw new Error(`Bing sign-in failed at ${detected.state}`)
        }).finalize(page, account, sessionOnly)
    }

    async getAppAccessToken(page: Page, email: string) {
        this.bot.logger.debug(this.bot.isMobile, 'GET-APP-TOKEN', '正在请求 App 访问令牌')
        return await new MobileAccessLogin(this.bot, page).getAccessToken(email)
    }
}
