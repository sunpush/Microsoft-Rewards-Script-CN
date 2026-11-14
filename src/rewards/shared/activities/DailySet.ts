import { isEligiblePromotion } from '../PromotionEligibility'
import { BaseActivity } from './BaseActivity'
import type { RewardsState } from '../../types/RewardsState'
import { PromotionRunner } from './PromotionRunner'

export class DailySet extends BaseActivity {
    async run(data: RewardsState): Promise<void> {
        const today = this.bot.utils.formatDate(Date.now(), this.bot.userData.timezone)
        const pending =
            data.dashboard.dailySetPromotions[today]?.filter(item =>
                isEligiblePromotion(item, this.bot.config.skipNonPointTasks)
            ) ?? []

        if (!pending.length) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-SET',
                '当前数据中没有符合条件的待处理“每日任务”项目'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-SET',
            `开始处理“每日任务”项目 | remaining=${pending.length}`
        )
        await new PromotionRunner(this.bot).run(pending, 'daily-set')
        this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', '“每日任务”项目处理完成')
    }
}
