import rebrowser, { type Browser, type BrowserContext } from 'patchright'
import { BrowserFingerprintWithHeaders, FingerprintGenerator } from 'fingerprint-generator'

import type { BotContext } from '../core/BotContext'
import { clearStorageState, loadSession, saveFingerprint } from '../session/SessionStore'
import { fingerprintMatchesLocale } from '../util/Locale'
import { buildBrowserProxy } from '../../scripts/lib/proxy.cjs'
import { UserAgentManager } from './UserAgent'
import { resolveBrowserRuntime, fingerprintOperatingSystem, browserLocaleArgs } from './BrowserRuntime'
import { newRewardsBrowserContext } from './RewardsBrowserContext'
import { browserTimeout } from './BrowserTiming'
import { onBrowserPageCrash } from './BrowserPageHealth'

import type { Account } from '../core/Account'

interface BrowserCreationResult {
    context: BrowserContext
}

class BrowserManager {
    private readonly bot: BotContext
    private readonly fingerprintGenerator = new FingerprintGenerator()
    private rootBrowser: Browser | null = null
    private rootAccountEmail = ''
    readonly userAgentManager: UserAgentManager

    constructor(bot: BotContext) {
        this.bot = bot
        this.userAgentManager = new UserAgentManager(bot)
    }

    async createBrowser(account: Account, { fresh = false } = {}): Promise<BrowserCreationResult> {
        const hasProxy = Boolean(account.proxy.url)
        const ignoreCertificateErrors = hasProxy && this.bot.config.proxy.ignoreCertificateErrors
        const runtime = resolveBrowserRuntime({
            configuredHeadless: this.bot.config.headless,
            ignoreCertificateErrors
        })

        let browser = this.rootBrowser
        const reusable = browser?.isConnected() === true && this.rootAccountEmail === account.email

        if (!reusable) {
            await this.closeBrowserProcess()
            const proxyConfig = buildBrowserProxy(account.proxy)

            if (ignoreCertificateErrors) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BROWSER-SECURITY',
                    '代理 proxy.ignoreCertificateErrors 已禁用 TLS 证书验证'
                )
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'BROWSER',
                `正在启动内置 Chromium | headless=${runtime.headless} (${runtime.headlessReason}) | platform=${process.platform}/${process.arch} | clicks=GhostCursor | proxy=${hasProxy ? 'yes' : 'no'} | tls=${ignoreCertificateErrors ? 'verification-disabled' : 'verified'} | sandbox=${runtime.sandboxDisabled ? 'disabled-root' : 'enabled'}`
            )

            try {
                browser = await rebrowser.chromium.launch({
                    headless: runtime.headless,
                    ...(proxyConfig && { proxy: proxyConfig }),
                    args: [...runtime.args, ...browserLocaleArgs(this.bot.accountLocale)]
                })
                this.rootBrowser = browser
                this.rootAccountEmail = account.email

                const version = browser.version()
                const isRealEdge = /^Edg(A)?\//i.test(version)
                this.userAgentManager.setEngineVersion(version, { isRealEdge })
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'BROWSER-ENGINE',
                    `检测到内置引擎 "${version}" | isRealEdge=${isRealEdge} | 浏览器与 App 的 Chrome 版本沿用此引擎`
                )
            } catch (error) {
                await browser?.close().catch(() => undefined)
                this.rootBrowser = null
                this.rootAccountEmail = ''
                const errorMessage = error instanceof Error ? error.message : String(error)
                this.bot.logger.error(this.bot.isMobile, 'BROWSER', `浏览器启动失败：${errorMessage}`)
                throw error
            }
        } else {
            this.bot.logger.debug(
                this.bot.isMobile,
                'BROWSER',
                `复用 Chromium 进程 | platform=${process.platform}/${process.arch} | account=${account.email}`
            )
        }

        if (!browser) throw new Error('Chromium process is unavailable')

        try {
            const session = loadSession(this.bot.config.sessionPath, account.email, this.bot.isMobile)
            if (session && (session.unrelatedCookiesRemoved || session.originsRemoved)) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SESSION',
                    `已清理已保存的会话 | unrelatedCookiesRemoved=${session.unrelatedCookiesRemoved} | originsRemoved=${session.originsRemoved} | 保留=Microsoft/Bing/MSN 的 Cookie`
                )
            }

            const shouldUseFingerprint = this.bot.isMobile
                ? account.saveFingerprint.mobile
                : account.saveFingerprint.desktop

            const savedFingerprint = shouldUseFingerprint ? session?.fingerprint : null
            const profileMatches =
                !savedFingerprint || this.userAgentManager.matchesFingerprint(savedFingerprint, this.bot.isMobile)
            const reuseFingerprint =
                savedFingerprint && profileMatches && fingerprintMatchesLocale(savedFingerprint, this.bot.accountLocale)

            const restoredStorageState =
                !fresh && session?.storageState && reuseFingerprint ? session.storageState : null

            if (restoredStorageState && session) {
                const ageMinutes = Math.max(0, Math.floor((Date.now() - session.updatedAt) / 60000))
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SESSION',
                    `正在恢复已保存的浏览器会话 | cookies=${restoredStorageState.cookies.length} | origins=${restoredStorageState.origins.length} | ageMinutes=${ageMinutes}` +
                        (session.expiredCookiesRemoved
                            ? ` | expiredCookiesRemoved=${session.expiredCookiesRemoved}`
                            : '')
                )
            } else if (fresh) {
                this.bot.logger.info(this.bot.isMobile, 'SESSION', '正在开始全新登录，不使用已保存的 Cookie')
            } else if (session?.storageState) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SESSION',
                    `已保存的 Cookie 因配套的指纹不可用或不兼容而被丢弃 | shouldUseFingerprint=${shouldUseFingerprint} | savedFingerprintPresent=${!!session.fingerprint} | profileMatch=${profileMatches} | localeMatch=${!!savedFingerprint && fingerprintMatchesLocale(savedFingerprint, this.bot.accountLocale)}`
                )
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SESSION',
                    '未找到已保存的浏览器会话；可能需要登录'
                )
            }

            if (savedFingerprint && !reuseFingerprint) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'BROWSER-FINGERPRINT',
                    `已保存指纹的语言环境或浏览器配置发生变化；正在为 ${this.bot.accountLocale.locale} 生成新的指纹`
                )
            }

            let fingerprint: BrowserFingerprintWithHeaders
            if (reuseFingerprint && savedFingerprint) {
                fingerprint = await this.userAgentManager.updateFingerprintUserAgent(
                    savedFingerprint,
                    this.bot.isMobile
                )
            } else {
                fingerprint = await this.generateFingerprint(this.bot.isMobile)
            }

            const screen = fingerprint.fingerprint.screen

            const context = await newRewardsBrowserContext(
                browser,
                fingerprint,
                {
                    permissions: [],
                    ignoreHTTPSErrors: ignoreCertificateErrors,
                    ...(restoredStorageState ? { storageState: restoredStorageState } : {}),
                    ...(this.bot.isMobile
                        ? {
                              isMobile: true,
                              hasTouch: true,
                              deviceScaleFactor: screen.devicePixelRatio,
                              viewport: { width: screen.width, height: screen.height },
                              screen: { width: screen.width, height: screen.height }
                          }
                        : {})
                },
                browserTimeout(this.bot)
            )

            const isMobile = this.bot.isMobile
            context.on('page', p => {
                onBrowserPageCrash(p, () =>
                    this.bot.logger.warn(isMobile, 'BROWSER', `浏览器标签页崩溃 | url=${p.url()}`)
                )
            })
            context.on('close', () => this.bot.logger.debug(this.bot.isMobile, 'BROWSER', '浏览器上下文已关闭'))

            if (shouldUseFingerprint) {
                if (session?.storageState && !profileMatches) {
                    clearStorageState(this.bot.config.sessionPath, account.email, this.bot.isMobile)
                }
                saveFingerprint(this.bot.config.sessionPath, account.email, this.bot.isMobile, fingerprint)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'BROWSER',
                `已创建上下文 | profile=${this.bot.isMobile ? 'android-browser' : 'rewards-desktop-app'} | engine=${browser.version()} | locale=${this.bot.accountLocale.locale} | Accept-Language="${this.bot.accountLocale.acceptLanguage}" | User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`
            )
            this.bot.logger.debug(
                this.bot.isMobile,
                'BROWSER-FINGERPRINT',
                `platform=${fingerprint.fingerprint.navigator.platform} | screen=${screen.width}x${screen.height}` +
                    ` | pixelRatio=${screen.devicePixelRatio} | persisted=${shouldUseFingerprint}`
            )

            return { context }
        } catch (error) {
            await this.closeBrowserProcess()
            throw error
        }
    }

    async closeBrowserProcess(): Promise<void> {
        const browser = this.rootBrowser
        this.rootBrowser = null
        this.rootAccountEmail = ''
        if (!browser) return

        await browser.close().catch(() => undefined)
        this.bot.logger.debug(this.bot.isMobile, 'CLOSE-BROWSER', 'Chromium 进程已关闭')
    }

    private async generateFingerprint(isMobile: boolean): Promise<BrowserFingerprintWithHeaders> {
        const fingerPrintData = this.fingerprintGenerator.getFingerprint({
            devices: isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: isMobile ? ['android'] : [fingerprintOperatingSystem()],
            browsers: [{ name: 'chrome' }],
            locales: this.bot.accountLocale.acceptedLocales
        })

        return this.userAgentManager.updateFingerprintUserAgent(fingerPrintData, isMobile)
    }
}

export default BrowserManager
