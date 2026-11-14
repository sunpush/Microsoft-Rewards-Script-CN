import { appPromotionType } from './AppPromotion'
import { activityResult } from '../shared/ActivityResult'
import type { BotContext } from '../../core/BotContext'
import type { AppDashboardData, Promotion } from './types/AppDashboardData'
import type { AppEarnablePoints } from '../types/Points'
import { HttpError } from '../../network/HttpError'

export interface PreparedAppActivities {
    data: AppDashboardData | null
    earnable: AppEarnablePoints | null
    dailyCheckIn?: Promotion
    readToEarn?: Promotion
}

export class AppActivityRunner {
    constructor(private readonly bot: BotContext) {}

    async prepare(): Promise<PreparedAppActivities> {
        const workers = this.bot.config.workers
        const enabled = workers.doDailyCheckIn || workers.doAppPromotions || workers.doReadToEarn
        const prepared: PreparedAppActivities = { data: null, earnable: null }
        if (!enabled) return prepared

        if (this.bot.accessTokens.mobile) {
            try {
                prepared.data = await this.bot.appPlatform.getDashboard()
                prepared.earnable = await this.bot.appPlatform.getEarnablePoints(prepared.data)
            } catch (error) {
                if (error instanceof HttpError && error.status === 401) this.bot.accessTokens.mobile = ''
                this.bot.signal.throwIfAborted()
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `应用数据不可用；跳过应用活动 | ${error instanceof Error ? error.message : String(error)}`
                )
                prepared.data = null
            }
        }
        if (!this.bot.accessTokens.mobile || !prepared.data) {
            this.bot.logger.event('main', 'POINTS', '应用积分不可用', {
                kind: 'quota',
                app: null,
                appState: 'unavailable'
            })
            this.bot.recordActivity('app-data', activityResult('unconfirmed', 'app-data-unavailable'))
            return prepared
        }

        this.bot.recordActivity('app-data', activityResult('confirmed', 'app-data-loaded'))
        this.bot.logger.event(
            'main',
            'POINTS',
            `可用应用积分：${prepared.earnable!.totalEarnablePoints ?? 'unknown'}`,
            {
                kind: 'quota',
                app: prepared.earnable!.totalEarnablePoints,
                appState: 'available'
            }
        )
        prepared.dailyCheckIn = prepared.data.response.promotions.find(
            promotion => appPromotionType(promotion) === 'checkin'
        )
        prepared.readToEarn = prepared.data.response.promotions.find(
            promotion => appPromotionType(promotion) === 'msnreadearn'
        )
        if (workers.doDailyCheckIn && !prepared.dailyCheckIn) {
            this.bot.logger.debug('main', 'DAILY-CHECK-IN', '没有可用的每日签到推广；跳过')
        }
        if (workers.doReadToEarn && !prepared.readToEarn) {
            this.bot.logger.debug('main', 'READ-TO-EARN', '没有可用的 Read to Earn 推广；跳过')
        }
        return prepared
    }

    async run(prepared: PreparedAppActivities): Promise<void> {
        if (!this.bot.accessTokens.mobile || !prepared.data) return
        const workers = this.bot.config.workers
        if (workers.doDailyCheckIn && prepared.dailyCheckIn)
            await this.bot.activities.dailyCheckIn(prepared.dailyCheckIn)
        if (workers.doAppPromotions) await this.bot.activities.runAppPromotions(prepared.data)
        if (workers.doReadToEarn && prepared.readToEarn) await this.bot.activities.readToEarn(prepared.readToEarn)
    }
}
