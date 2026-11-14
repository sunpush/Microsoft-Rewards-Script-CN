import { getMorePromotions } from '../Promotion'
import { isEligiblePromotion } from '../PromotionEligibility'
import { BaseActivity } from './BaseActivity'
import type { RewardsState } from '../../types/RewardsState'
import { PromotionRunner } from './PromotionRunner'

export class MorePromotions extends BaseActivity {
    async run(data: RewardsState): Promise<void> {
        const promotions = getMorePromotions(data.dashboard)

        const pending = promotions.filter(promotion =>
            isEligiblePromotion(promotion, this.bot.config.skipNonPointTasks)
        )
        if (!pending.length) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                '当前数据中没有符合条件的待处理“更多推广”项目'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            `开始处理“更多推广”项目 | remaining=${pending.length}`
        )
        await new PromotionRunner(this.bot).run(pending, 'more-promotions')
        this.bot.logger.debug(this.bot.isMobile, 'MORE-PROMOTIONS', '“更多推广”项目处理完成')
    }
}
