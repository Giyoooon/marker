// 테스트용: Workers 런타임의 'cloudflare:workers' 대신 쓰는 최소한의 DurableObject
export class DurableObject<Env = unknown> {
  constructor(public ctx: DurableObjectState, public env: Env) {}
}
