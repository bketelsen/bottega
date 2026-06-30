# Running Bottega under systemd

[`bottega.service`](bottega.service) is a **template** unit for running the
reference implementation as a long-lived service. It is written for a
**per-user** service (`systemd --user`) so Bottega runs as your own user, with
your own coding-agent credentials (`~/.claude`, `~/.codex`, …), without needing
root.

> The template uses the `%h` specifier, which systemd expands to your home
> directory. The examples below assume the repo is checked out at
> `~/bottega`. Adjust paths if yours differs.

## Prerequisites

- Node (see [`reference/.nvmrc`](../../reference/.nvmrc)) and `pnpm` installed
  and resolvable from the unit's `PATH`.
- Dependencies installed: `cd reference && pnpm install`.
- A configured [`reference/.env`](../../reference/.env.example) — in particular
  `JWT_SECRET` is **required**.

## Install (per-user service)

```bash
# 1. Copy the template into your user unit directory.
mkdir -p ~/.config/systemd/user
cp contrib/systemd/bottega.service ~/.config/systemd/user/bottega.service

# 2. Edit the marked values (WorkingDirectory, ExecStart, EnvironmentFile, PATH)
#    to match where you checked out the repo and how node/pnpm are installed.
$EDITOR ~/.config/systemd/user/bottega.service

# 3. Reload systemd and enable + start the service.
systemctl --user daemon-reload
systemctl --user enable --now bottega.service
```

### Keep it running when you're logged out

A `systemd --user` instance normally stops when your last session ends. To let
Bottega keep running across logout/reboot, enable lingering for your user
(needs sudo once):

```bash
sudo loginctl enable-linger "$USER"
```

## Choosing a launcher

Set `ExecStart` to one of:

- **`prod-start.sh`** — builds the client bundle (`vite build`) and serves the
  full web UI plus the API from a single process. Use this for the normal
  web-UI deployment.
- **`headless-start.sh`** — API-only (sets `HEADLESS=1`): serves the REST API,
  WebSocket, and OpenAPI docs, but no frontend. Use this for container/daemon
  deployments driven purely over the API.

## Managing the service

```bash
systemctl --user status bottega.service     # check status
systemctl --user restart bottega.service     # restart
systemctl --user stop bottega.service        # stop
journalctl --user -u bottega.service -f      # follow logs
```

By default the app listens on `PORT=3001` (configurable in `.env`).

## Running as a system-wide service instead

If you prefer a root-managed service (e.g. a dedicated `bottega` user on a
server), copy the unit to `/etc/systemd/system/bottega.service`, replace every
`%h` with an absolute path, add `User=` / `Group=` lines under `[Service]`,
change `WantedBy=` to `multi-user.target`, and use `systemctl` /
`journalctl -u bottega` without the `--user` flag.
