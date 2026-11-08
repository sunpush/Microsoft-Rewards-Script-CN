import { ghostClick } from '../../GhostClick'
import { browserTimeout } from '../../BrowserTiming'
import type { Page } from 'patchright'
import type { LoginContext } from '../LoginContext'
import { canPromptForInput, getErrorMessage, promptInput, waitForInputResponse } from './LoginUtils'

export class RecoveryLogin {
    private readonly textInputSelector =
        'input#proof-confirmation-email-input, input[data-testid="proof-confirmation"], [data-testid="proof-confirmation"] input'
    private readonly maxManualSeconds = 60
    private readonly maxManualAttempts = 5

    constructor(private bot: LoginContext) {}

    private async fillEmail(page: Page, email: string): Promise<boolean> {
        try {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '正在填写恢复邮箱')

            this.bot.signal.throwIfAborted()
            const timeout = browserTimeout(this.bot)
            const input = page.locator(`:is(${this.textInputSelector}):visible`).first()
            await input.waitFor({ state: 'visible', timeout })
            await ghostClick(page, input, timeout, this.bot.signal)
            await input.fill(email, { timeout })
            await input.press('Enter', { timeout })
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '恢复邮箱已提交，正在等待响应')
            return true
        } catch (error) {
            this.bot.signal.throwIfAborted()
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                `填写邮箱输入框失败：${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async handle(page: Page, recoveryEmail: string): Promise<void> {
        try {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '已启动邮箱恢复验证流程')

            if (recoveryEmail) {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '正在使用已配置的恢复邮箱')

                const filled = await this.fillEmail(page, recoveryEmail)
                if (!filled) {
                    throw new Error('Email input field not found')
                }

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '正在等待页面响应')
                await waitForInputResponse(page, this.textInputSelector, browserTimeout(this.bot))

                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    throw new Error(`Email verification failed: ${errorMessage}`)
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    '已收到恢复邮箱响应；正在检查下一个登录状态'
                )
                return
            }

            if (!canPromptForInput()) {
                throw new Error('Recovery email is required because interactive stdin is unavailable')
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                '未提供恢复邮箱，将提示用户输入'
            )

            for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `正在开始第 ${attempt}/${this.maxManualAttempts} 次尝试`
                )

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `正在提示用户输入邮箱（超时：${this.maxManualSeconds} 秒）`
                )

                const email = await promptInput({
                    question: `Recovery email (waiting ${this.maxManualSeconds}s): `,
                    timeoutSeconds: this.maxManualSeconds,
                    validate: email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
                })

                if (!email) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `未收到或收到无效的邮箱输入（第 ${attempt}/${this.maxManualAttempts} 次尝试）`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: no input received')
                    }
                    continue
                }

                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `收到的邮箱格式无效（第 ${attempt}/${this.maxManualAttempts} 次尝试） | length=${email.length}`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: invalid format')
                    }
                    continue
                }

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '已收到用户提供的有效恢复邮箱')

                const filled = await this.fillEmail(page, email)
                if (!filled) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `填写邮箱输入框失败（第 ${attempt}/${this.maxManualAttempts} 次尝试）`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Email input field not found after maximum attempts')
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '正在等待页面响应')
                await waitForInputResponse(page, this.textInputSelector, browserTimeout(this.bot))

                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `页面返回错误："${errorMessage}"（第 ${attempt}/${this.maxManualAttempts} 次尝试）`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error(`Maximum attempts reached. Last error: ${errorMessage}`)
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    '已收到恢复邮箱响应；正在检查下一个登录状态'
                )
                return
            }

            throw new Error(`Email input failed after ${this.maxManualAttempts} attempts`)
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'LOGIN-RECOVERY', `发生致命错误：${errorMsg}`)
            throw error
        }
    }
}
