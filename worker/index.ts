// DG-Voice Worker 入口。
//
// 纯静态资源托管：前端直连各家 realtime 语音接口（xAI / OpenAI / Azure / 智谱 GLM，均已
// 验证支持浏览器 CORS 直连，含临时票据签发端点），不需要任何服务端中转或密钥代理。
// 这个 Worker 目前只做 SPA 静态资源托管，保留 fetch handler 是为了以后如果需要加服务端
// 能力（比如某个 provider 后续不再支持浏览器直连）时有地方挂载，而不必新建 Worker。
export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
