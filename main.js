'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

class CptAdapter extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'cpt',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.log.info('ChargePoint Adapter (cpt) gestartet');

        // Konfiguration auslesen
        this.log.debug('Geladene Konfiguration: ' + JSON.stringify(this.config));

        const stations = this.config.stations || [];
        const intervalMinutes = this.config.interval || 5;

        this.log.info(`Anzahl konfigurierter Stationen: ${stations.length}`);
        this.log.info(`Abfrageintervall: ${intervalMinutes} Minuten`);

        if (stations.length === 0) {
            this.log.warn('Keine Stationen in der Konfiguration definiert');
            return;
        }

        // Objekte / States für jede Station erstellen
        for (const station of stations) {
            if (!station.id || !station.name) {
                this.log.warn(`Ungültige Station: ${JSON.stringify(station)} – name oder id fehlt`);
                continue;
            }

            const safeName = this.cleanName(station.name);
            const prefix = `stations.${safeName}`;

            // Channel für die Station
            await this.setObjectNotExistsAsync(prefix, {
                type: 'channel',
                common: {
                    name: station.name,
                },
                native: {},
            });

            // Wichtige States
            const states = [
                { id: 'status',           name: 'Status',           type: 'string',  role: 'value' },
                { id: 'availablePorts',   name: 'Freie Anschlüsse', type: 'number',  role: 'value' },
                { id: 'latitude',         name: 'Breitengrad',      type: 'number',  role: 'value.latitude' },
                { id: 'longitude',        name: 'Längengrad',       type: 'number',  role: 'value.longitude' },
                { id: 'address',          name: 'Adresse',          type: 'string',  role: 'location' },
                { id: 'lastUpdate',       name: 'Letztes Update',   type: 'string',  role: 'date' },
                { id: 'error',            name: 'Fehlermeldung',    type: 'string',  role: 'text' },
            ];

            for (const s of states) {
                await this.setObjectNotExistsAsync(`${prefix}.${s.id}`, {
                    type: 'state',
                    common: {
                        name: s.name,
                        type: s.type,
                        role: s.role,
                        read: true,
                        write: false,
                    },
                    native: {},
                });
            }

            // Geräte-ID als Info speichern
            await this.setObjectNotExistsAsync(`${prefix}.deviceId`, {
                type: 'state',
                common: {
                    name: 'Device ID',
                    type: 'string',
                    role: 'value',
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateAsync(`${prefix}.deviceId`, { val: String(station.id), ack: true });
        }

        // Erste Abfrage sofort ausführen
        await this.updateAllStations(stations);

        // Dann periodisch abfragen
        this.updateInterval = setInterval(() => {
            this.updateAllStations(stations);
        }, intervalMinutes * 60 * 1000);

        this.log.info(`Polling gestartet – alle ${intervalMinutes} Minuten`);
    }

    /**
     * Alle Stationen abfragen und States aktualisieren
     * @param {Array} stations
     */
    async updateAllStations(stations) {
        for (const station of stations) {
            const safeName = this.cleanName(station.name);
            const prefix = `stations.${safeName}`;

            try {
                const url = `https://mc.chargepoint.com/map-prod/v3/station/info?deviceId=${station.id}`;
                this.log.debug(`Abfrage für ${station.name} (ID ${station.id}): ${url}`);

                const response = await axios.get(url, { timeout: 10000 });
                const data = response.data;

                this.log.debug(`Antwort erhalten: ${JSON.stringify(data).substring(0, 200)}...`);

                // States setzen (anpassen, wenn die API-Struktur anders ist)
                await this.setStateAsync(`${prefix}.status`,        { val: data?.stationStatus || 'unknown', ack: true });
                await this.setStateAsync(`${prefix}.availablePorts`, { val: Number(data?.availablePorts || 0), ack: true });
                await this.setStateAsync(`${prefix}.latitude`,      { val: Number(data?.latitude || null), ack: true });
                await this.setStateAsync(`${prefix}.longitude`,     { val: Number(data?.longitude || null), ack: true });
                await this.setStateAsync(`${prefix}.address`,       { val: data?.address || '', ack: true });
                await this.setStateAsync(`${prefix}.lastUpdate`,    { val: new Date().toISOString(), ack: true });
                await this.setStateAsync(`${prefix}.error`,         { val: '', ack: true });

                this.log.info(`Station ${station.name} aktualisiert`);
            } catch (err) {
                const errMsg = err.message || String(err);
                this.log.error(`Fehler bei Station ${station.name} (ID ${station.id}): ${errMsg}`);
                await this.setStateAsync(`${prefix}.status`, { val: 'error', ack: true });
                await this.setStateAsync(`${prefix}.error`,  { val: errMsg, ack: true });
            }
        }
    }

    /**
     * Namen für ioBroker-State-IDs bereinigen
     */
    cleanName(name) {
        return (name || 'station')
            .toString()
            .toLowerCase()
            .replace(/[^a-z0-9äöüß]/gi, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    /**
     * Is called when adapter shuts down
     */
    onUnload(callback) {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        this.log.info('Adapter wird beendet');
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options) => new CptAdapter(options);
} else {
    new CptAdapter();
}