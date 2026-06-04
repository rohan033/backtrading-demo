export const CONTROL_MARKET_WS = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/control/market`

export type ControlMarketSubscribe = {
  broker: string
  symbol: string
  token?: string
  exchange?: string
  account_env?: string
  use_fake_client?: boolean
  feed_mode?: string
}
