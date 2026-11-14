import {
    activityResult,
    activityFailure,
    nonReportableOfferResult,
    type ActivityResult
} from '../../shared/ActivityResult'
import { URLs } from '../../../constants/urls'
import type { BasePromotion } from '../../types/RewardsState'
import { BaseActivity } from '../../shared/activities/BaseActivity'
import { isSkippedOffer } from '../../shared/PromotionEligibility'
import { FlyoutActivityReport } from './FlyoutActivityReport'
import { OfferVerifier } from '../../shared/OfferVerifier'
import { pointValue } from '../../shared/PointAccounting'

export class ApiUrlReward extends BaseActivity {
    async run(promotion: BasePromotion): Promise<ActivityResult> {
        const offerId = promotion.offerId
        if (isSkippedOffer(offerId, promotion.destinationUrl)) {
            this.bot.logger.debug(this.bot.isMobile, 'URL-REWARD-API', `永久跳过 offer | offerId=${offerId}`)
            return activityResult('skipped', 'offer-excluded', offerId)
        }
        const live = await this.bot.rewards.resolveOffer(offerId)
        if (!live) return this.reportThroughFlyout(promotion)
        if (!live.reportable) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD-API',
                `当前无法上报 offer | offerId=${offerId}`
            )
            return nonReportableOfferResult(live)
        }
        if (this.bot.config.skipNonPointTasks && live.points <= 0) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD-API',
                `跳过 ${offerId}：不奖励积分且 skipNonPointTasks=true`
            )
            return activityResult('skipped', 'no-points', offerId)
        }

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD-API',
                `跳过 ${offerId}：未发现 "reportActivity"`
            )
            return activityResult('unconfirmed', 'action-id-unavailable', offerId)
        }

        const verifier = this.verifier(offerId)
        if (await verifier.capture()) return activityResult('skipped', 'already-complete', offerId)
        const oldBalance = this.bot.userData.currentPoints
        const dashboardActivityType = Number(promotion.activityType)
        const activityType =
            live.activityType ??
            (Number.isInteger(dashboardActivityType) && dashboardActivityType > 0 ? dashboardActivityType : 11)

        this.bot.logger.debug(
            this.bot.isMobile,
            'URL-REWARD-API',
            `正在上报 Rewards offer | offerId=${offerId} | currentBalance=${oldBalance}`
        )

        let outcome: ActivityResult
        try {
            const result = await this.bot.rewards.reportServerAction(
                actionId,
                [
                    live.hash,
                    activityType,
                    {
                        offerid: offerId,
                        isPromotional: live.isPromotional ? true : '$undefined',
                        timezoneOffset: this.bot.userData.timezoneOffset
                    }
                ],
                {
                    url: URLs.rewards.earn,
                    referer: URLs.rewards.earn,
                    routerStateTree: this.bot.pageParser.routerStateTree('earn')
                }
            )

            if (result.availablePoints !== null) this.bot.userData.currentPoints = result.availablePoints
            outcome = {
                ...activityResult(
                    'unconfirmed',
                    result.acknowledged ? 'server-acknowledged' : 'server-not-acknowledged',
                    offerId
                ),
                pointsKnown: false
            }
            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD-API',
                `offer 响应 | offerId=${offerId} | status=${result.status} | acknowledged=${result.acknowledged}`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD-API',
                `API offer 失败 | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
            outcome = { ...activityFailure(error, offerId), pointsKnown: false }
        }

        const verified = await verifier.verify(outcome)
        const details =
            `offerId=${offerId} | pointsGained=${verified.pointsKnown === false ? 'unknown' : verified.pointsGained}` +
            ` | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${oldBalance} | reason=${verified.reason}`
        if (verified.status === 'confirmed') {
            this.bot.logger.debug(this.bot.isMobile, 'URL-REWARD-API', `API offer 已完成 | ${details}`)
        } else {
            this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD-API', `API offer 未确认 | ${details}`)
        }
        return verified
    }

    private async reportThroughFlyout(promotion: BasePromotion): Promise<ActivityResult> {
        const offerId = promotion.offerId
        if (promotion.complete) return activityResult('skipped', 'already-complete', offerId)
        const verifier = this.verifier(offerId)
        if (await verifier.capture()) return activityResult('skipped', 'already-complete', offerId)
        let outcome: ActivityResult
        let report
        try {
            report = await new FlyoutActivityReport(this.bot).report(promotion)
            outcome = activityResult(
                'unconfirmed',
                report?.accepted ? 'flyout-acknowledged' : 'flyout-not-acknowledged',
                offerId
            )
        } catch (error) {
            outcome = activityFailure(error, offerId)
        }
        const verified = await verifier.verify(outcome, report ?? undefined)
        this.bot.logger.debug(
            this.bot.isMobile,
            'URL-REWARD-API',
            `任务栏 offer 已验证 | offerId=${offerId} | status=${verified.status}` +
                ` | pointsGained=${verified.pointsKnown ? verified.pointsGained : 'unknown'}` +
                ` | currentBalance=${this.bot.userData.currentPoints}`
        )
        return verified
    }

    private verifier(offerId: string): OfferVerifier {
        return new OfferVerifier(this.bot, offerId, async () => {
            const snapshot = await this.bot.rewards.refreshEarnSnapshot()
            const offer = snapshot?.offers.find(item => item.offerId === offerId)
            return offer
                ? {
                      complete: offer.isCompleted,
                      progress: pointValue(offer.pointProgress),
                      maximum: pointValue(offer.points)
                  }
                : undefined
        })
    }
}
