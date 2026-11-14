import { describeExecutionPlan } from '../config/ExecutionPlan'
import type { BotContext } from './BotContext'

export function logExecutionMode(bot: BotContext): void {
    const plan = describeExecutionPlan(bot.config)
    bot.logger.debug('main', 'RUN-PLAN', JSON.stringify(plan))
    const exp = bot.config.experimental
    const browserMode = bot.config.rewardsMode === 'browser'

    if (browserMode) {
        bot.logger.special(
            'main',
            'REWARDS-MODE',
            '浏览器模式已启用 - 将优先启动桌面端，在 /earn 回退前尝试在任务栏中处理每日任务和更多奖励，并使用渲染后的控件执行网页活动。'
        )

        const appApiExceptions = [
            bot.config.workers.doDailyCheckIn && 'doDailyCheckIn',
            bot.config.workers.doAppPromotions && 'doAppPromotions'
        ].filter(Boolean) as string[]
        if (appApiExceptions.length) {
            bot.logger.debug(
                'main',
                'REWARDS-MODE',
                `浏览器模式已启用仅应用 API 例外：${appApiExceptions.join(', ')}。` +
                    '这些 worker 仍会获取应用访问令牌并使用 Microsoft Rewards 应用平台 API。'
            )
        }

        if (bot.config.workers.doVisualSearch) {
            bot.logger.debug(
                'main',
                'REWARDS-MODE',
                'doVisualSearch 将使用渲染后的 Rewards 激活控件和 Bing Visual Search 界面。'
            )
        }
    }

    if (bot.config.workers.doClaimBonusPoints) {
        bot.logger.debug('main', 'REWARDS-MODE', 'doClaimBonusPoints 在两种模式下始终通过 API 领取。')
    }

    if (exp.edgeBrowsing) {
        bot.logger.debug(
            'main',
            'EXPERIMENTAL',
            'edgeBrowsing 已启用 - 仅在桌面端会话上运行，桌面端登录后在后台执行，适用于两种 Rewards 模式。'
        )
    }

    if (browserMode && exp.browserSearchApiReport) {
        bot.logger.special(
            'main',
            'EXPERIMENTAL',
            "browserSearchApiReport 已启用：在桌面端搜索阶段后检查今天的 Bing 搜索连续签到，仅在未确认完成时发送一次 API 搜索，包括跳过桌面端搜索的情况。"
        )
    }

    if (!browserMode) {
        bot.logger.special(
            'main',
            'REWARDS-MODE',
            'API 模式仅使用浏览器登录和捕获 Cookie；所有活动、搜索和 Visual Search 继续通过 HTTP 执行。'
        )
        bot.logger.debug(
            'main',
            'REWARDS-MODE',
            `API 模式 | 桌面端：${plan.desktopSession} | 移动端：${plan.mobileSession}`
        )
    }
}
