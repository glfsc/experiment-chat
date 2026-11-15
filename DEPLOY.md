# 部署说明

本系统是单进程 Node.js 应用，零第三方依赖；生产环境只需要 Node.js（>= 22.13.0）和一个反向代理。

## 1. 准备

```bash
git clone <本仓库地址> experiment-chat
cd experiment-chat
node --version   # 必须 >= 22.13.0
```

## 2. 首次启动

```bash
# 建议显式设置初始管理员密码（至少 10 位）
ADMIN_PASSWORD='请换成强密码123!' PORT=3000 node server.js
```

- 首次启动会自动创建 `data.db` 与管理员 `admin`。
- 不设置 `ADMIN_PASSWORD` 时，系统生成一次性随机密码并打印到启动日志；只打印一次。
- 登录后请立即修改管理员密码。

## 3. 常驻运行

### systemd（Linux）

```ini
# /etc/systemd/system/experiment-chat.service
[Unit]
Description=Experiment Chat
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/experiment-chat
Environment=PORT=3000
Environment=ADMIN_PASSWORD=请换成强密码123!
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now experiment-chat
sudo systemctl status experiment-chat
```

> 首次建库后再修改 `ADMIN_PASSWORD` 不会改变已有密码；之后请用管理端「个人设置」修改。

### 直接运行

```bash
nohup node server.js > app.log 2>&1 &
```

## 4. 反向代理（Nginx）

```nginx
server {
    listen 80;
    server_name your-domain.example;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用 HTTPS 可用 Certbot：

```bash
sudo certbot --nginx -d your-domain.example
```

## 5. 数据与备份

- 数据库文件：`data.db`、`data.db-wal`、`data.db-shm`。
- 备份时三个文件一起复制；恢复时一起放回。
- 建议定期把数据库备份到独立位置，并限制文件权限。
- 不要提交 `data.db` 或备份文件到 git。

## 6. 升级

1. 备份数据库三个文件。
2. 拉取新代码。
3. 重启 Node 进程。
4. 打开管理端抽查问卷、作答与导出。

## 7. 安全检查

- [ ] 已修改管理员初始密码。
- [ ] `data.db` 不在 Web 根目录之外暴露（本系统通过 Node 提供静态文件，无需额外配置）。
- [ ] 已配置 HTTPS。
- [ ] 已限制服务器 SSH / 面板访问。
- [ ] 已建立数据库备份。
- [ ] 如不需要自助注册，设置 `ALLOW_REGISTRATION=0`。
