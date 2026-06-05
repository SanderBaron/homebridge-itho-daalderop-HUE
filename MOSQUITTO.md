# Mosquitto MQTT Broker setup (Mac Mini)

## Install

```bash
brew install mosquitto
```

## Configure

Create `/opt/homebrew/etc/mosquitto/mosquitto.conf` (or edit the existing one):

```conf
# Allow connections on port 1883 (no TLS for local network)
listener 1883 0.0.0.0

# Allow anonymous connections (add auth later if needed)
allow_anonymous true

# Persist messages across restarts
persistence true
persistence_location /opt/homebrew/var/lib/mosquitto/

# Log to file
log_dest file /opt/homebrew/var/log/mosquitto/mosquitto.log
log_type all
```

## Start as a service (auto-start on login)

```bash
brew services start mosquitto
```

Check status:

```bash
brew services list | grep mosquitto
```

## Configure the Itho WiFi module

Open the Itho web interface at `http://192.168.2.82/` and go to **Settings → MQTT**:

| Field | Value |
|-------|-------|
| Server | `<Mac Mini IP>` (e.g. `192.168.2.10`) |
| Port | `1883` |
| Username | *(leave empty)* |
| Password | *(leave empty)* |
| Status topic | `itho/ithostatus` |
| State topic | `itho/state` |
| Command topic | `itho/cmd` |

Click **Save** and the module should connect immediately.

## Verify the connection

Watch all MQTT messages from the Itho module:

```bash
mosquitto_sub -h localhost -t "itho/#" -v
```

You should see messages like:
```
itho/ithostatus {"temp":25.2,"hum":49.8,"Speed status":37,...}
itho/state 37
```

## Plugin config (Homebridge)

In the Homebridge plugin settings, set:

- **Protocol**: MQTT
- **IP address**: `<Mac Mini IP>` (e.g. `192.168.2.10`)
- **Port**: `1883`
- **Itho device IP (for dashboard)**: `192.168.2.82`

## Troubleshoot

```bash
# View Mosquitto logs
tail -f /opt/homebrew/var/log/mosquitto/mosquitto.log

# Test publish
mosquitto_pub -h localhost -t "itho/cmd" -m '{"vremote":"medium"}'

# Test subscribe
mosquitto_sub -h localhost -t "itho/ithostatus"
```
