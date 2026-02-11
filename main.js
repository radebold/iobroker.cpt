'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');


function isTrue(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'on' || v === 'yes'; }
class CptAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'cpt' });

        this.pollInterval = null;

        // cache last derived status per station for transition detection
        this.lastStatusByStation = {};
        this.lastFreePortsByStation = {};
        this.stationPrefixByName = {};

        this.on('message', this.onMessage.bind(this));
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    makeSafeName(name) {
        return (name || '')
            .toString()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    normalizeStatus(val) {
        const s = (val ?? 'unknown').toString().toLowerCase();
        return s || 'unknown';
    }

    deriveStationStatusFromPorts(ports) {
        const statuses = (Array.isArray(ports) ? ports : []).map((p) => this.normalizeStatus(p?.statusV2 || p?.status));
        if (statuses.some((s) => ['in_use', 'charging', 'occupied'].includes(s))) return 'in_use';
        if (statuses.some((s) => s === 'available')) return 'available';
        if (statuses.some((s) => ['unavailable', 'out_of_service', 'faulted', 'offline'].includes(s))) return 'unavailable';
        return statuses[0] || 'unknown';
    }

    pickCity(data1, data2) {
        const c1 = data1?.address?.city;
        const c2 = data2?.address?.city;
        return (c1 || c2 || 'Unbekannt').toString().trim() || 'Unbekannt';
    }

    getStationKey(station) {
        const base = station.name ? station.name : `station_${station.deviceId1}`;
        return this.makeSafeName(base) || `station_${station.deviceId1}`;
    }

    async ensureCityChannel(cityPrefix, cityName) {
        await this.setObjectNotExistsAsync(cityPrefix, { type: 'channel', common: { name: cityName }, native: {} });
    }

    async ensureToolsObjects() {
        await this.setObjectNotExistsAsync('tools', { type: 'channel', common: { name: 'Tools' }, native: {} });

        await this.setObjectNotExistsAsync('tools.export', {
            type: 'state',
            common: { name: 'Export Stationen (Trigger)', type: 'boolean', role: 'button', read: true, write: true, def: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.exportJson', {
            type: 'state',
            common: { name: 'Export JSON', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.exportFile', {
            type: 'state',
            common: { name: 'Export Datei (Adapter-Datenverzeichnis)', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.lastExport', {
            type: 'state',
            common: { name: 'Letzter Export', type: 'string', role: 'date', read: true, write: false },
            native: {},
        });

        // NEW: Test communication button + result
        await this.setObjectNotExistsAsync('tools.testNotifyAll', {
            type: 'state',
            common: { name: 'Test: Notify ALL (Trigger)', type: 'boolean', role: 'button', read: true, write: true, def: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.testNotify', {
            type: 'state',
            common: { name: 'Kommunikation testen (Trigger)', type: 'boolean', role: 'button', read: true, write: true, def: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.lastTest', {
            type: 'state',
            common: { name: 'Letzter Test', type: 'string', role: 'date', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.lastTestResult', {
            type: 'state',
            common: { name: 'Letztes Testergebnis', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        await this.setStateAsync('tools.export', { val: false, ack: true });
        await this.setStateAsync('tools.testNotify', { val: false, ack: true });
    }

    async ensureStationObjects(stationPrefix, station) {
        await this.setObjectNotExistsAsync(stationPrefix, { type: 'channel', common: { name: station.name }, native: {} });

        await this.setObjectNotExistsAsync(`${stationPrefix}.deviceId1`, {
            type: 'state',
            common: { name: 'Device ID (P1)', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${stationPrefix}.deviceId1`, { val: String(station.deviceId1), ack: true });

        await this.setObjectNotExistsAsync(`${stationPrefix}.deviceId2`, {
            type: 'state',
            common: { name: 'Device ID (P2)', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${stationPrefix}.deviceId2`, { val: station.deviceId2 ? String(station.deviceId2) : '', ack: true });

        await this.setObjectNotExistsAsync(`${stationPrefix}.enabled`, {
            type: 'state',
            common: { name: 'Aktiv', type: 'boolean', role: 'indicator', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${stationPrefix}.enabled`, { val: !!station.enabled, ack: true });

        // Per station notify flag (writable)
        await this.setObjectNotExistsAsync(`${stationPrefix}.testNotify`, {
            type: 'state',
            common: { name: 'Test: Notify (Button)', type: 'boolean', role: 'button', read: true, write: true, def: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.notifyOnAvailable`, {
            type: 'state',
            common: { name: 'Benachrichtigen wenn verfügbar', type: 'boolean', role: 'switch', read: true, write: true, def: false },
            native: {},
        });
        const curNotify = await this.getStateAsync(`${stationPrefix}.notifyOnAvailable`);
        if (!curNotify || curNotify.val === null || curNotify.val === undefined) {
            await this.setStateAsync(`${stationPrefix}.notifyOnAvailable`, { val: !!station.notifyOnAvailable, ack: true });
        }

        await this.setObjectNotExistsAsync(`${stationPrefix}.statusDerived`, {
            type: 'state',
            common: { name: 'Status (aus Ports)', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.portCount`, {
            type: 'state',
            common: { name: 'Anzahl Ports', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.freePorts`, {
            type: 'state',
            common: { name: 'Freie Ports', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.lastUpdate`, {
            type: 'state',
            common: { name: 'Letztes Update', type: 'string', role: 'date', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.ports`, { type: 'channel', common: { name: 'Ports' }, native: {} });
    }

    async ensurePortObjects(stationPrefix, outletNumber) {
        const portPrefix = `${stationPrefix}.ports.${outletNumber}`;
        await this.setObjectNotExistsAsync(portPrefix, { type: 'channel', common: { name: `Port ${outletNumber}` }, native: {} });

        const states = [
            ['status', { name: 'Status', type: 'string', role: 'value' }],
            ['statusV2', { name: 'StatusV2', type: 'string', role: 'value' }],
            ['evseId', { name: 'EVSE ID', type: 'string', role: 'value' }],
            ['maxPowerKw', { name: 'Max Power', type: 'number', role: 'value.power', unit: 'kW' }],
            ['level', { name: 'Level', type: 'string', role: 'text' }],
            ['displayLevel', { name: 'Display Level', type: 'string', role: 'text' }],
            ['plugType', { name: 'Plug Type', type: 'string', role: 'text' }],
            ['displayPlugType', { name: 'Display Plug Type', type: 'string', role: 'text' }],
            ['lastUpdate', { name: 'Letztes Update', type: 'string', role: 'date' }],
        ];

        for (const [id, common] of states) {
            await this.setObjectNotExistsAsync(`${portPrefix}.${id}`, { type: 'state', common: { read: true, write: false, ...common }, native: {} });
        }
        return portPrefix;
    }

    async cleanupRemovedStations(allowedStationChannels, allowedCityChannels) {
        const startkey = `${this.namespace}.stations.`;
        const endkey = `${this.namespace}.stations.\u9999`;

        const view = await this.getObjectViewAsync('system', 'channel', { startkey, endkey });
        const rows = view?.rows || [];

        for (const row of rows) {
            const id = row.id;
            const rel = id.substring(`${this.namespace}.`.length);
            const parts = rel.split('.');
            if (parts.length === 3 && parts[0] === 'stations') {
                if (!allowedStationChannels.has(id)) {
                    this.log.info(`Station nicht mehr in Config → lösche Objekte rekursiv: ${id}`);
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
        }

        const view2 = await this.getObjectViewAsync('system', 'channel', { startkey, endkey });
        const rows2 = view2?.rows || [];
        for (const row of rows2) {
            const id = row.id;
            const rel = id.substring(`${this.namespace}.`.length);
            const parts = rel.split('.');
            if (parts.length === 2 && parts[0] === 'stations') {
                if (!allowedCityChannels.has(id)) {
                    this.log.info(`Ort nicht mehr in Config → lösche Channel rekursiv: ${id}`);
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
        }
    }

    getChannels() {
        const channels = Array.isArray(this.config.channels) ? this.config.channels : [];
        return channels
            .filter((c) => c && c.enabled !== false && c.instance)
            .map((c) => ({
                instance: String(c.instance).trim(),
                user: c.user !== undefined && c.user !== null ? String(c.user).trim() : '',
                label: c.label !== undefined && c.label !== null ? String(c.label).trim() : '',
            }))
            .filter((c) => {
                const ok = c.instance.startsWith('telegram.') || c.instance.startsWith('whatsapp-cmb.') || c.instance.startsWith('pushover.');
                if (!ok) this.log.warn(`Kommunikations-Instanz wird ignoriert (nicht erlaubt): ${c.instance}`);
                return ok;
            });
    }


    async sendMessageToChannels(text, ctx = {}) {
        let channels = [];
        try {
            channels = (typeof this.getChannels === 'function' ? this.getChannels() : []) || [];
        } catch (e) {
            this.log.warn(`getChannels() failed: ${e.message}`);
            channels = [];
        }
        if (channels.length === 0) {
            this.log.debug('Keine Kommunikationskanäle konfiguriert – Versand übersprungen');
            return { ok: 0, failed: 0, note: 'no_channels' };
        }

        let ok = 0;
        let failed = 0;

        for (const ch of activeChannels) {
            const inst = ch.instance;
            const u = ch.user;
            const lbl = ch.label;
            const isTelegram = inst.startsWith('telegram.');
            const isWhatsAppCmb = inst.startsWith('whatsapp-cmb.');
            const isPushover = inst.startsWith('pushover.');

            let payload;
            if (isTelegram) {
                payload = { text, ...(u ? { user: u } : {}) };
            } else if (isWhatsAppCmb) {
                payload = {
                    phone: u || undefined,
                    number: u || undefined,
                    to: u || undefined,
                    text,
                    message: text,
                    title: 'ChargePoint',
                    channelLabel: lbl || undefined,
                };
            } else if (isPushover) {
                payload = { message: text, sound: '' };
            } else {
                payload = { text };
            }

            if (!payload.city && ctx && ctx.city) payload.city = ctx.city;
            if (!payload.station && ctx && ctx.station) payload.station = ctx.station;
            if (payload.freePorts === undefined && ctx && ctx.freePorts !== undefined) payload.freePorts = ctx.freePorts;
            if (payload.portCount === undefined && ctx && ctx.portCount !== undefined) payload.portCount = ctx.portCount;
            if (!payload.status && ctx && ctx.status) payload.status = ctx.status;

            Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);



            try {
                if (!payload.city && ctx && ctx.city) payload.city = ctx.city;
                if (!payload.station && ctx && ctx.station) payload.station = ctx.station;
                if (payload.freePorts === undefined && ctx && ctx.freePorts !== undefined) payload.freePorts = ctx.freePorts;
                if (payload.portCount === undefined && ctx && ctx.portCount !== undefined) payload.portCount = ctx.portCount;
                if (!payload.status && ctx && ctx.status) payload.status = ctx.status;
                this.sendTo(ch.instance, 'send', payload);
                ok++;
                this.log.info(`Message gesendet über ${ch.instance} (${ch.label || 'Channel'})`);
            } catch (e) {
                failed++;
                this.log.warn(`sendTo fehlgeschlagen (${ch.instance}): ${e.message}`);
            }
        }

        return { ok, failed, note: 'sent' };
    }

    async sendAvailableNotification(ctx) {
        const prefix = ctx.isTest ? 'TEST: ' : '';
        const text = `${prefix}Ladestation ${ctx.station} in ${ctx.city} ist nun frei${ctx.freePorts !== undefined && ctx.portCount !== undefined ? ` (${ctx.freePorts}/${ctx.portCount})` : ''}`;
        return this.sendMessageToChannels(text, ctx);
    }


    async sendTestNotifyForPrefix(stationPrefix) {
        // stationPrefix is like "stations.city.station"
        try {
            const cityKey = stationPrefix.split('.')[1] || 'unbekannt';
            const stationKey = stationPrefix.split('.')[2] || 'station';
            // Try to get friendly names from states (fallback to keys)
            const nameState = await this.getStateAsync(`${stationPrefix}.name`).catch(() => null);
            const cityState = await this.getStateAsync(`${stationPrefix}.city`).catch(() => null);
            const freePortsState = await this.getStateAsync(`${stationPrefix}.freePorts`).catch(() => null);
            const portCountState = await this.getStateAsync(`${stationPrefix}.portCount`).catch(() => null);

            const stationName = (nameState && nameState.val) ? String(nameState.val) : stationKey;
            const cityName = (cityState && cityState.val) ? String(cityState.val) : cityKey;
            const freePorts = (freePortsState && freePortsState.val !== undefined) ? Number(freePortsState.val) : undefined;
            const portCount = (portCountState && portCountState.val !== undefined) ? Number(portCountState.val) : undefined;

            await this.sendAvailableNotification({
                isTest: true,
                station: stationName,
                city: cityName,
                freePorts,
                portCount,
            });

            this.log.info(`TEST Notify gesendet: ${stationName} (${cityName})`);
        } catch (e) {
            this.log.warn(`TEST Notify fehlgeschlagen für ${stationPrefix}: ${e.message}`);
        }
    }

    
async onMessage(obj) {
    try {
        if (!obj || !obj.command) return;

        this.log.debug(`onMessage: command=${obj.command}, from=${obj.from}`);

        if (obj.command === 'testChannel') {
            const instance = (obj.message?.instance || '').toString().trim();
            const user = (obj.message?.user || '').toString().trim();
            const label = (obj.message?.label || '').toString().trim();

            if (!instance) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: 'Kein Adapter-Instanz gesetzt' }, obj.callback);
                return;
            }

            try {
                await this.sendTestMessageViaChannel({ instance, user, label }, 'TEST: Kommunikation OK ✅');
                obj.callback && this.sendTo(obj.from, obj.command, { result: 'ok' }, obj.callback);
            } catch (e) {
                this.log.warn(`TEST Notify failed for channel ${instance}: ${e.message}`);
                obj.callback && this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
            }
            return;
        }

        if (obj.command === 'testStation') {
            const nameRaw = (obj.message?.name || obj.message?.stationName || '').toString().trim();
            const nameKey = nameRaw.toLowerCase();

            if (!nameRaw) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: 'Kein Stations-Name gesetzt' }, obj.callback);
                return;
            }

            this.log.info(`UI TEST Station Button: ${nameRaw}`);

            let stationPrefix = this.stationPrefixByName?.[nameKey];

            // Fallback: search by created objects
            if (!stationPrefix) {
                const all = await this.getForeignObjectsAsync(`${this.namespace}.stations.*.*.statusDerived`);
                for (const id of Object.keys(all || {})) {
                    const parts = id.split('.');
                    const station = parts[4] || '';
                    if (station.toLowerCase() === nameKey.replace(/\s+/g, '_')) {
                        stationPrefix = `stations.${parts[3]}.${parts[4]}`;
                        break;
                    }
                }
            }

            if (!stationPrefix) {
                this.log.warn(`UI TEST: Station nicht gefunden: ${nameRaw}`);
                obj.callback && this.sendTo(obj.from, obj.command, { error: 'station_not_found' }, obj.callback);
                return;
            }

            await this.sendTestNotifyForPrefix(stationPrefix);

            obj.callback && this.sendTo(obj.from, obj.command, { result: 'ok' }, obj.callback);
            return;
        }

    } catch (e) {
        this.log.warn(`onMessage error: ${e.message}`);
    }
}

onUnload(callback) {(callback) {
        try {
            if (this.pollInterval) clearInterval(this.pollInterval);
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new CptAdapter(options);
} else {
    new CptAdapter();
}
