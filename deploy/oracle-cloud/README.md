# Oracle Cloud: lightweight chart hosting

This deployment serves the charting app as static files. Nginx runs as a small
system service; the chart code runs in each device's browser and connects
directly to Delta Exchange's public market-data API and WebSocket. There is no
Docker, application server, recorder, or Node process on the VM.

This is a good fit for a 1 OCPU / 1 GB RAM Ubuntu or Oracle Linux 9 VM,
including Oracle Ampere (ARM64). The VM serves the app; chart rendering and
exchange connections use the device that opens the page. A slow client device
or exchange/network latency can still affect responsiveness.

## Private access from your devices (recommended)

Use Tailscale Serve to expose Nginx over your private tailnet with HTTPS. This
avoids opening web ports to the public internet. Install Tailscale and sign in
on the VM and on each device that should access the chart.

In the Oracle Cloud network security list / NSG, allow SSH only from your
current public IP (or use Tailscale SSH). Do not add public ingress rules for
ports 80 or 443.

## One-time VM setup

Create an Ubuntu 24.04 or Oracle Linux 9 VM and connect over SSH. Clone this
repository on the VM to get the setup script; Node.js is not needed on the VM:

```sh
git clone <your-repository-url> candl
cd candl
sudo ./deploy/oracle-cloud/install.sh "$USER"
```

The script installs/enables Nginx, configures it to serve `/var/www/candl` on
`127.0.0.1:8080`, disables the package sample site, and makes that directory
writable by your login user. On Oracle Linux it also reapplies the default
SELinux content labels. It does not open firewall ports or install Docker.

Install Tailscale on the VM, authenticate it, and configure the private HTTPS
endpoint. Enable MagicDNS and HTTPS certificates for your tailnet in the
Tailscale admin console if they are not already enabled:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 8080
sudo tailscale serve status
```

Use the HTTPS URL shown by `tailscale serve status` from devices signed in to
the same tailnet. Tailscale Serve configuration persists across restarts;
Nginx and Tailscale are enabled as system services.

## Build and publish from your computer

Build on your development computer rather than the 1 GB VM. From the repository
root, install the project dependencies if needed, then build the static app:

```sh
npm ci
./deploy/oracle-cloud/build.sh
```

Publish the generated bundle to the VM. Use its Tailscale IP or DNS name as the
SSH host so the transfer stays on your tailnet:

```sh
./deploy/oracle-cloud/publish.sh ubuntu@<tailscale-ip-or-name>
```

The script synchronizes only the generated chart bundle to `/var/www/candl`.
Repeat the build and publish commands after updating the app. No process
restart is needed for static file updates.

## What is and is not included

- Live candles, ticker, trades, and order-book features use the browser's
  connection to Delta's public endpoints.
- Historical Big Trades / Deep Trades tape is unavailable because this setup
  intentionally does not run the recorder. Those tools can still use live
  trades where supported.
- Trade Buddy's Claude bridge is a development-only service and is not
  available in this static deployment.
- Browser-local settings and saved layouts stay in each device's browser; they
  are not synchronized by this server.
- MAP V3 needs the small MAP recorder below; without it the indicator shows
  "MAP V3 recorder not reachable".

## MAP V3 recorder (optional)

MAP V3 builds gold levels from GLD options. CBOE's free feed can't be read from
a browser and keeps no history, so a small Node service saves the chain twice
per US trading day, at 08:15 and 16:20 New York time, and Nginx proxies
`/maplevels/` to it. The schedule follows US daylight saving automatically
(Node's built-in time-zone data), whatever time zone the VM is set to.

On the VM, from the cloned repository (Node.js 22.18 or newer):

```sh
sudo apt-get install -y nodejs   # or: sudo dnf module install nodejs:22 (check node -v >= 22.18)
sed -e "s#CANDL_USER#$USER#" -e "s#CANDL_REPO#$PWD#" deploy/oracle-cloud/map-recorder.service \
  | sudo tee /etc/systemd/system/map-recorder.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now map-recorder
sudo ./deploy/oracle-cloud/install.sh "$USER"   # reinstalls the Nginx config with /maplevels/
curl -s http://127.0.0.1:8788/maplevels/status
```

Snapshots are kept 400 days in `/var/lib/candl-map` (about 230 KB per day).
`git pull` and `sudo systemctl restart map-recorder` after updating it.

The Nginx config enables gzip and long-lived caching only for Vite's
content-hashed assets. The HTML entry point is revalidated so published
updates are picked up promptly.
