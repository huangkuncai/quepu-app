# TLS/WSS 反向代理基线

应用进程只监听内网 HTTP/WebSocket，公网入口由受管 TLS 终止层提供 HTTPS/WSS。证书、私钥和真实域名不进入仓库；生产部署必须由运维在 secret manager 和证书自动续期系统中配置。

## Nginx 示例

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.invalid;

    ssl_certificate     /etc/letsencrypt/live/api.example.invalid/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.invalid/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location /ws {
        proxy_pass http://susong_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Request-Id $request_id;
        proxy_read_timeout 75s;
        proxy_send_timeout 10s;
    }

    location /api/ {
        proxy_pass http://susong_app;
        proxy_set_header Host $host;
        proxy_set_header X-Request-Id $request_id;
    }
}

upstream susong_app {
    server 127.0.0.1:8787;
}
```

## 发布检查

- 只允许 HTTPS/WSS；明文端口仅绑定内网或本机开发环境。
- `ALLOWED_ORIGINS` 使用精确 origin 列表；原生客户端可不发送 `Origin`，浏览器客户端必须配置白名单。
- 反向代理和应用都限制请求体/帧大小；应用的 `WS_MAX_PAYLOAD_BYTES` 是最终门禁。
- 代理日志和应用日志不得记录 Authorization、验证码、token 或私牌。
- 证书续期、TLS 扫描、WSS 握手、断线重连和优雅关闭必须在 G4 真机/ staging 验收中留证。

