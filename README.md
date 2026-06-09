<p align="center">
<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

<p align="center">
  <img alt="Homebridge 2.0" src="https://img.shields.io/badge/homebridge-2.x-blueviolet" />
  &nbsp;
  <img alt="Node.js" src="https://img.shields.io/badge/node-18%20%E2%80%93%2024-brightgreen" />
  &nbsp;
  <img alt="Philips Hue" src="https://img.shields.io/badge/Philips%20Hue-ge%C3%AFntegreerd-0065D3" />
  &nbsp;
  <a href="LICENSE" title="MIT license"><img alt="mit license" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

# Homebridge Itho Daalderop HUE

Een Homebridge-plugin die je [Itho Daalderop](https://www.ithodaalderop.nl/) mechanische ventilatie-unit (CVE) naar Apple HomeKit brengt via de [WiFi add-on module](https://github.com/arjenhiemstra/ithowifi) van Arjen Hiemstra — en daar een complete badkamer-automatisering bovenop bouwt met Philips Hue.

## Het verhaal

Deze plugin begon als fork van [homebridge-itho-daalderop](https://github.com/jvandenaardweg/homebridge-itho-daalderop) van Jordy van den Aardweg — een prima plugin, maar al jaren niet meer onderhouden en niet compatibel met moderne Homebridge-versies. Deze fork is van de grond af gemoderniseerd én flink uitgebreid:

- **Homebridge 2.x en Node.js 18 t/m 24** — draait op de nieuwste stack, inclusief child bridge-isolatie
- **Philips Hue-integratie** — de plugin praat rechtstreeks met je Hue Bridge en gebruikt lampen en schakelaars als actuators en sensors voor ventilatie-automatisering
- **Slimme vochtigheidsautomaat** — douche-detectie volgens de officiële Itho-specificatie (absolute drempel én snelle-stijging-detectie)
- **Eigen dashboard in de Homebridge UI** — live sensordata, Hue Bridge-koppeling en alle instellingen in een eigen interface

## Functies

### HomeKit

- **Ventilator-accessoire** met live snelheidsweergave (laag / middel / hoog)
- **Turbo-schakelaar** — ventilator tijdelijk op de hoogste stand, met automatische terugkeer na een instelbare tijd
- **Luchtkwaliteitsensor** — CO₂ (ppm + waarschuwing boven 1500 ppm), luchtvochtigheid en temperatuur als volwaardige HomeKit-sensors, bruikbaar in je eigen Home-automatiseringen

### Automatiseringen

- **Vochtigheidsautomaat** — detecteert douchen en zet de ventilator op hoog. Twee modi:
  - *Badkamer*: absolute drempel **of** snelle stijging (bijv. 3% binnen 24s, conform Itho-spec) triggert de boost; een minimale cooldown voorkomt pendelen
  - *Wasruimte*: drie drempelzones (laag / auto / hoog) zonder cooldown
- **Spiegelverwarming (Hue)** — schakelt een Hue-stopcontact/lamp met de spiegelverwarming in op basis van de externe RFT-RV vochtigheidssensor, met instelbare brandtijd, vertraging na de fan-boost en optionele handmatige bediening via een Hue-knop
- **Toilet-ventilatie (Hue)** — detecteert het toiletlicht via een Hue-schakelaar: brandt het licht langer dan de ingestelde tijd, dan gaat de CVE een instelbare periode op maximum
- **Tijdschema** — vaste ventilatiestanden per dag(deel), bijv. 's ochtends luchten
- **Dagelijkse failsafe-reset** — zet de unit elke nacht terug naar CO₂-automatisch, zodat een vergeten handmatige stand nooit dagen blijft hangen

### Eigen Homebridge UI

- **Dashboard** met live sensordata van de unit (snelheid, CO₂, vochtigheid, temperatuur)
- **Hue Bridge-koppeling** rechtstreeks vanuit de plugin: bridge-discovery, koppelen met de fysieke knop, en dropdowns met al je lampen en schakelaars
- **Alle instellingen** in begrijpelijk Nederlands, zonder handmatig JSON te bewerken

## Vereisten

- Itho Daalderop ventilatie-unit met geïnstalleerde [WiFi add-on module](https://github.com/arjenhiemstra/ithowifi) (zie ook het [Tweakers-topic](https://gathering.tweakers.net/forum/list_messages/1976492))
- Homebridge 2.0 of nieuwer, Node.js 18 of nieuwer
- *Optioneel:* een MQTT-broker (aanbevolen — geen polling, directe updates)
- *Optioneel:* een Philips Hue Bridge voor de spiegelverwarming- en toilet-automatiseringen

## Installatie

Deze plugin staat (nog) niet op NPM. Installeren vanaf GitHub:

```bash
git clone https://github.com/SanderBaron/homebridge-itho-daalderop-HUE.git
cd homebridge-itho-daalderop-HUE
npm install
npm run build
npm link
```

Herstart daarna Homebridge. De plugin verschijnt als `homebridge-itho-daalderop-hue` en is het beste te draaien als **child bridge** (aan te zetten via het QR-icoon op de pluginpagina).

## Configuratie

Gebruik bij voorkeur de eigen plugin-UI (tabblad *Instellingen*). Een voorbeeldconfig voor een CVE met ingebouwde CO₂-sensor via MQTT:

```json
{
  "platform": "HomebridgeIthoDaalderop",
  "name": "Itho Daalderop",
  "api": {
    "protocol": "mqtt",
    "ip": "127.0.0.1",
    "port": 1883,
    "deviceIp": "192.168.2.82"
  },
  "device": { "co2Sensor": true },
  "hue": {
    "bridgeIp": "192.168.2.16",
    "apiKey": "…"
  },
  "automation": {
    "turbo": { "durationMinutes": 20 },
    "humidity": {
      "enabled": true,
      "mode": "badkamer",
      "boostThreshold": 85,
      "dropThreshold": 82,
      "cooldownMinutes": 20,
      "riseRate": 3,
      "riseWindowSeconds": 24
    }
  },
  "dailyReset": { "enabled": true, "time": "02:00" }
}
```

## Over snelheidsregeling

Units met een ingebouwde CO₂-sensor (zoals de CVE-S Optima Inside) en non-CVE-units (HRU-350, DemandFlow, QualityFlow) negeren handmatige snelheidscommando's — daar werkt alleen de virtuele afstandsbediening met drie standen. Zet daarvoor `device.co2Sensor` of `device.nonCve` op `true`; de plugin vertaalt de Home App-snelheid dan automatisch:

| Home App | Virtuele afstandsbediening |
| -------- | -------------------------- |
| 0–33%    | laag                       |
| 67%      | middel (CO₂-automatisch)   |
| 100%     | hoog                       |

De Home App "snapt" vanzelf naar de dichtstbijzijnde stand.

## Problemen oplossen

Zet `verboseLogging` aan in de plugininstellingen en bekijk de Homebridge-logs. Vragen of problemen? [Open een issue](https://github.com/SanderBaron/homebridge-itho-daalderop-HUE/issues).

## Met dank aan

- [Jordy van den Aardweg](https://github.com/jvandenaardweg) — de oorspronkelijke [homebridge-itho-daalderop](https://github.com/jvandenaardweg/homebridge-itho-daalderop) waar deze plugin op voortbouwt
- [Arjen Hiemstra](https://github.com/arjenhiemstra) — de onmisbare [WiFi add-on module](https://github.com/arjenhiemstra/ithowifi) voor Itho-units

## Licentie

[MIT](LICENSE)
