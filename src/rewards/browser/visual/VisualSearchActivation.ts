import { BrowserTaskPage } from '../../../browser/BrowserTaskPage'
import type { Locator, Page } from 'patchright'

import type { ParsedOffer } from '../../shared/parsers/RewardsPageParser'
import { BaseActivity } from '../../shared/activities/BaseActivity'
import { BrowserRewardNavigator } from '../actions/BrowserRewardNavigator'
import { browserTaskPass } from '../BrowserTaskPass'
import { activationOutcome, activationException, type ActivationOutcome } from '../../shared/ActivationOutcome'

export class VisualSearchActivation extends BaseActivity {
    private readonly navigator = new BrowserRewardNavigator(this.bot)

    async click(target: ParsedOffer): Promise<ActivationOutcome> {
        const sourcePage = this.navigator.getActivePage()
        if (!sourcePage) {
            this.bot.logger.warn(this.bot.isMobile, 'VISUAL-SEARCH-BROWSER', '激活所需的浏览器页面不可用')
            return activationOutcome('unconfirmed', 'activation-page-unavailable', target.offerId)
        }

        const pass = browserTaskPass.getStore()
        const passPage = pass?.surface === 'earn' && !pass.page?.isClosed() ? pass.page : undefined
        const task = passPage ? undefined : await BrowserTaskPage.createRewards(sourcePage)
        const page = passPage ?? task!.page
        try {
            await this.navigator.openEarn(page)
            let control = await this.navigator.findOfferControl(page, {
                destination: target.destination,
                offerId: target.offerId,
                title: target.title
            })
            control ??= await this.findSemanticActivationControl(page)

            if (!control) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH-BROWSER',
                    `没有匹配到渲染的视觉搜索激活控件 | offerId=${target.offerId}`
                )
                return activationOutcome('unconfirmed', 'activation-control-missing', target.offerId)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'VISUAL-SEARCH-BROWSER',
                `正在点击渲染的激活控件 | offerId=${target.offerId}`
            )
            try {
                const clicked = await this.navigator.click(page, control)
                await clicked.close()
            } catch (error) {
                return activationException(error, target.offerId, true)
            }
            return activationOutcome('unconfirmed', 'activation-not-confirmed', target.offerId, true)
        } finally {
            await task?.close()
        }
    }

    private async findSemanticActivationControl(page: Page): Promise<Locator | null> {
        const direct = await this.navigator.uniqueVisible(
            page
                .locator('a, button, [role="button"]')
                .filter({ hasText: /activate visual search|start visual search|visual search streak/i }),
            'visual search activation'
        )
        if (direct) return direct
        const cards = page
            .locator('article, li, [role="listitem"], [data-testid*="card" i], [class*="card" i]')
            .filter({ hasText: /visual search/i })
        return this.navigator.uniqueVisible(
            cards.locator('a, button, [role="button"]').filter({ hasText: /activate|start|enable|turn on/i }),
            'visual search activation'
        )
    }
}
