# OpenCode 自托管运行手册（Fork 版本）

> 目标：让 `opencode` 在 VPS 上 24 小时运行，并可从手机 iOS 客户端稳定访问。  
> 本文不包含任何私钥路径或真实公网地址，请按你的实际环境替换占位符。

---

## 1. 当前部署结构

- 运行方式：`systemd` 常驻服务
- 代码来源：你的 Fork 仓库源码（不是官方全局包）
- 服务监听：`127.0.0.1:4096`（仅本机）
- 手机访问：iOS 客户端内置 SSH Tunnel + Basic Auth

---

## 2. 关键路径

- 仓库目录：`/home/clawd/clawd/projects/opencode`
- 服务文件：`/etc/systemd/system/opencode.service`
- 密码文件：`/home/clawd/.config/opencode/server.env`
- 公钥授权：`/home/clawd/.ssh/authorized_keys`

---

## 3. 24 小时运行（systemd）

核心配置（示例）：

```ini
[Service]
User=clawd
Group=clawd
WorkingDirectory=/home/clawd/clawd/projects/opencode
Environment=HOME=/home/clawd
Environment=OPENCODE_DEFAULT_DIRECTORY=/home/clawd/clawd/projects
EnvironmentFile=/home/clawd/.config/opencode/server.env
ExecStart=/home/clawd/.bun/bin/bun run --cwd packages/opencode --conditions=browser src/index.ts serve --hostname 127.0.0.1 --port 4096
Restart=always
RestartSec=3
```

说明：
- `Restart=always`：进程退出后自动拉起。
- `enabled`：主机重启后自动启动服务。
- `OPENCODE_DEFAULT_DIRECTORY`：新会话默认目录为 `/home/clawd/clawd/projects`。

---

## 4. 服务管理命令

```bash
# 查看状态
systemctl status opencode.service --no-pager

# 重启服务
systemctl restart opencode.service

# 开机自启（通常已启用）
systemctl enable opencode.service

# 查看日志
journalctl -u opencode.service -n 200 --no-pager
```

健康检查（需 Basic Auth）：

```bash
PW=$(grep OPENCODE_SERVER_PASSWORD /home/clawd/.config/opencode/server.env | cut -d= -f2-)
curl -u opencode:$PW http://127.0.0.1:4096/global/health
```

---

## 5. 手机 iOS 客户端配置

### 5.1 Server Connection

- Address: `127.0.0.1:4096`
- Username: `opencode`
- Password: `server.env` 里的 `OPENCODE_SERVER_PASSWORD`

查看密码：

```bash
cat /home/clawd/.config/opencode/server.env
```

### 5.2 SSH Tunnel

- Enable SSH Tunnel: 开启
- VPS Host: `YOUR_VPS_IP_OR_DOMAIN`
- SSH Port: `22`
- Username: `clawd`
- VPS Port: `4096`

### 5.3 添加手机公钥

把 iOS App 里复制出来的公钥追加到：

```bash
echo "IOS_APP_PUBLIC_KEY_HERE" >> /home/clawd/.ssh/authorized_keys
chown clawd:clawd /home/clawd/.ssh/authorized_keys
chmod 600 /home/clawd/.ssh/authorized_keys
```

---

## 6. 在 VPS 上使用 attach（TUI）

```bash
cd /home/clawd/clawd/projects/opencode
PW=$(grep OPENCODE_SERVER_PASSWORD /home/clawd/.config/opencode/server.env | cut -d= -f2-)
/home/clawd/.bun/bin/bun run --cwd packages/opencode --conditions=browser src/index.ts \
  attach http://127.0.0.1:4096 \
  --dir /home/clawd/clawd/projects \
  -p "$PW"
```

用 `screen` 挂后台：

```bash
screen -S opencode-ui
# 在 screen 中运行 attach
# 挂起保留会话：Ctrl+A 然后 D
# 重新进入：screen -r opencode-ui
```

---

## 7. 更新 Fork 代码并生效

```bash
cd /home/clawd/clawd/projects/opencode

# 拉取你的 fork 更新
git pull

# 更新依赖（建议每次 pull 后执行）
/home/clawd/.bun/bin/bun install

# 重启服务使新代码生效
systemctl restart opencode.service

# 验证
systemctl status opencode.service --no-pager
```

---

## 8. 修改服务密码

```bash
echo "OPENCODE_SERVER_PASSWORD=NEW_PASSWORD" > /home/clawd/.config/opencode/server.env
chown clawd:clawd /home/clawd/.config/opencode/server.env
chmod 600 /home/clawd/.config/opencode/server.env
systemctl restart opencode.service
```

---

## 9. 稳定性建议（防 OOM）

```bash
swapon --show
free -h
```

如果没有 swap，可创建 4G：

```bash
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo "/swapfile none swap sw 0 0" >> /etc/fstab
```

---

## 10. 常见问题

### Q1. SSH Tunnel 显示 Connected，但 Test Connection 失败
- 常见原因 1：Address 只填了 `127.0.0.1`，没填端口。
- 正确写法：`127.0.0.1:4096`
- 常见原因 2：未填写 Basic Auth 密码，返回 401。

### Q2. 会话目录不对
- 新会话目录由 `OPENCODE_DEFAULT_DIRECTORY` 控制。
- 旧会话保留旧目录；请新建会话验证。

### Q3. 主机重启后服务未启动
- 检查：`systemctl status opencode.service`
- 启用开机启动：`systemctl enable opencode.service`

---

## 11. 安全提醒

- 不要把 `server.env`、私钥、公网 IP 写进公开仓库。
- `authorized_keys` 保持 `600` 权限。
- 若密码泄露，立刻修改 `OPENCODE_SERVER_PASSWORD` 并重启服务。
