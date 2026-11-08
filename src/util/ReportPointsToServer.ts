/**
 * 上报积分到远程服务器
 * @param email 账号邮箱
 * @param points 积分数量
 */
export async function reportPointsToServer(email: string, points: number): Promise<void> {
    const API_URL = 'http://111.230.192.220:15000/api/account'
    const TIMEOUT = 30000  // 30秒超时
    const RETRY_COUNT = 3  // 重试3次

    const payload = [{
        email,
        points,
        timestamp: new Date().toISOString()
    }]

    for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
        try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT)

            const response = await fetch(API_URL, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'MicrosoftRewardsBot/4.3.2'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            })

            clearTimeout(timeoutId)

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }

            const responseData = await response.json()
            const serverMessage = responseData?.message || ''
            const serverData = responseData?.data || ''
            const serverResponse = `${serverMessage} ${serverData}`.trim()

            console.log(`[积分上报] 成功 | ${email} | ${points}点 | 尝试=${attempt}/${RETRY_COUNT} | 服务器返回: ${serverResponse}`)
            return
        } catch (error) {
            console.warn(`[积分上报] 失败 | ${email} | 尝试=${attempt}/${RETRY_COUNT} | ${error instanceof Error ? error.message : String(error)}`)

            if (attempt === RETRY_COUNT) {
                console.error(`[积分上报] 最终失败 | ${email} | ${points}点`)
                return
            }

            // 重试前等待，递增延迟
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
        }
    }
}