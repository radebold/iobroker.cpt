'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');


function parseNumberLocale(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (!s) return NaN;
    // handle German decimal comma like "9,56280495" and strip units/symbols like "°"
    // keep only digits, minus, comma and dot
    const cleaned = s.replace(/\s+/g, '').replace(/[^0-9,\.-]/g, '');
    const norm = cleaned.replace(',', '.');
    const n = Number(norm);
    return Number.isFinite(n) ? n : NaN;
}


function isTrue(v) {
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on' || v === 'yes';
}

class CptAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'cpt' });

        this.pollInterval = null;

        this.visHtmlTimer = null;
        this.nearestTimer = null;
        this.nearestDebounceMs = 1500;
        this.visHtmlObjectId = (this.config && this.config.visHtmlObjectId) || '0_userdata.0.Vis.ChargePoint.htmlStations';
        this.visHtmlEnabled = (this.config && this.config.visHtmlEnabled !== undefined) ? isTrue(this.config.visHtmlEnabled) : true;
        this.visHtmlDebounceMs = Number((this.config && this.config.visHtmlDebounceMs) || 800);

        // Optional: separate (smaller) mobile HTML variant for VIS
        this.visHtmlMobileObjectId = (this.config && this.config.visHtmlMobileObjectId) || '0_userdata.0.Vis.ChargePoint.htmlStationsMobile';
        this.visHtmlMobileEnabled = (this.config && this.config.visHtmlMobileEnabled !== undefined) ? isTrue(this.config.visHtmlMobileEnabled) : true;

        // transition detection (per stationPrefix)
        this.lastFreePortsByStation = {};
        this.stationPrefixByName = {};

        // car position (optional) - can be sourced from foreign states
        this.carLat = null;
        this.carLon = null;
        this.carSoc = null;
        this.carLatStateId = (this.config && this.config.carLatStateId) ? String(this.config.carLatStateId).trim() : '';
        this.carLonStateId = (this.config && this.config.carLonStateId) ? String(this.config.carLonStateId).trim() : '';
        this.carSocStateId = (this.config && this.config.carSocStateId) ? String(this.config.carSocStateId).trim() : '';
        this.carLatStatic = (this.config && this.config.carLat !== undefined && this.config.carLat !== null && this.config.carLat !== '') ? Number(this.config.carLat) : null;
        this.carLonStatic = (this.config && this.config.carLon !== undefined && this.config.carLon !== null && this.config.carLon !== '') ? Number(this.config.carLon) : null;

        // Notification filters
        this.notifySocBelow = (this.config && this.config.notifySocBelow !== undefined && this.config.notifySocBelow !== null && this.config.notifySocBelow !== '')
            ? Number(this.config.notifySocBelow)
            : 30;
        this.notifyMaxDistanceM = (this.config && this.config.notifyMaxDistanceM !== undefined && this.config.notifyMaxDistanceM !== null && this.config.notifyMaxDistanceM !== '')
            ? Number(this.config.notifyMaxDistanceM)
            : 500;

        this.notifyCooldownMin = (this.config && this.config.notifyCooldownMin !== undefined && this.config.notifyCooldownMin !== null && this.config.notifyCooldownMin !== '')
            ? Number(this.config.notifyCooldownMin)
            : 15;

        // per-station notify memory to avoid duplicates
        this.notifyMetaByStation = {}; // { [stationPrefixRel]: { inRange:boolean, notified:boolean, lastSent:number } }
        this.stationPrefixes = [];
        this.stationInfoByPrefix = {}; // { [prefix]: { city, name } }

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
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
        const base = station?.name ? station.name : `station_${station?.deviceId1}`;
        return this.makeSafeName(base) || `station_${station?.deviceId1}`;
    }

    extractGps(data1, data2) {
        const cand = [data1, data2].filter(Boolean);
        for (const d of cand) {
            const lat = d?.latitude ?? d?.lat ?? d?.location?.latitude ?? d?.location?.lat ?? d?.position?.latitude ?? d?.position?.lat;
            const lon =
                d?.longitude ??
                d?.lng ??
                d?.lon ??
                d?.location?.longitude ??
                d?.location?.lng ??
                d?.location?.lon ??
                d?.position?.longitude ??
                d?.position?.lng ??
                d?.position?.lon;

            if (typeof lat === 'number' && typeof lon === 'number') return { lat, lon };
            const latN = lat !== undefined ? Number(lat) : NaN;
            const lonN = lon !== undefined ? Number(lon) : NaN;
            if (!Number.isNaN(latN) && !Number.isNaN(lonN)) return { lat: latN, lon: lonN };
        }
        return null;
    }

    haversineKm(lat1, lon1, lat2, lon2) {
        const toRad = (d) => (d * Math.PI) / 180;
        const R = 6371; // km
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    async updateStateIfChanged(id, val, ack = true) {
        const cur = await this.getStateAsync(id).catch(() => null);
        const curVal = cur ? cur.val : undefined;
        if (cur === null || cur === undefined || curVal !== val) {
            await this.setStateAsync(id, { val, ack });
            return true;
        }
        return false;
    }

    async updateStatusAgeMin(stationPrefixRel) {
        try {
            const st = await this.getStateAsync(`${stationPrefixRel}.statusDerived`).catch(() => null);
            const lc = st && (st.lc || st.ts);
            if (!lc) return;
            const ageMin = Math.max(0, Math.floor((Date.now() - lc) / 60000));
            await this.updateStateIfChanged(`${stationPrefixRel}.statusAgeMin`, ageMin);
        } catch {
            // ignore
        }
    }

    // ---------- Admin / Config helpers ----------

    getActiveChannels(ctx = {}) {
        let channels = this.config.channels || [];

        if (channels && !Array.isArray(channels) && typeof channels === 'object') {
            channels = Object.values(channels);
        }
        if (typeof channels === 'string') {
            try {
                channels = JSON.parse(channels);
            } catch {
                channels = [];
            }
        }
        if (!Array.isArray(channels)) channels = [];

        let active = channels.filter((c) => c && isTrue(c.enabled) && c.instance);
        active = active
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

        if (ctx.onlyInstance) active = active.filter((c) => c.instance === String(ctx.onlyInstance));
        if (ctx.onlyLabel) active = active.filter((c) => (c.label || '').toLowerCase() === String(ctx.onlyLabel).toLowerCase());
        return active;
    }

    getSubscriptions() {
        let subs = this.config.subscriptions || [];
        if (subs && !Array.isArray(subs) && typeof subs === 'object') subs = Object.values(subs);
        if (typeof subs === 'string') {
            try {
                subs = JSON.parse(subs);
            } catch {
                subs = [];
            }
        }
        if (!Array.isArray(subs)) subs = [];
        return subs;
    }

    // ---------- Messaging ----------

    async sendMessageToChannels(text, ctx = {}) {
        const channels = this.getActiveChannels(ctx);
        if (!channels.length) {
            this.log.debug('Keine Kommunikationskanäle konfiguriert – Versand übersprungen');
            return { ok: 0, failed: 0, note: 'no_channels' };
        }

        let ok = 0;
        let failed = 0;

        for (const ch of channels) {
            const inst = ch.instance;
            const u = ch.user;
            const lbl = ch.label;

            const isTelegram = inst.startsWith('telegram.');
            const isWhatsAppCmb = inst.startsWith('whatsapp-cmb.');
            const isOpenWa = inst.startsWith('open-wa.');
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
            } else if (isOpenWa) {
                payload = { to: u || undefined, text };
            } else if (isOpenWa) {
                    payload = { to: user || undefined, text: 'CPT Test: Kommunikation OK ✅' };
                } else if (isPushover) {
                payload = { message: text, sound: '' };
            } else {
                payload = { text };
            }

            if (ctx.city && payload.city === undefined) payload.city = ctx.city;
            if (ctx.station && payload.station === undefined) payload.station = ctx.station;
            if (ctx.status && payload.status === undefined) payload.status = ctx.status;
            if (ctx.freePorts !== undefined && payload.freePorts === undefined) payload.freePorts = ctx.freePorts;
            if (ctx.portCount !== undefined && payload.portCount === undefined) payload.portCount = ctx.portCount;

            Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

            try {
                this.sendTo(inst, 'send', payload);
                ok++;
                this.log.info(`Message gesendet über ${inst}${lbl ? ' (' + lbl + ')' : ''}`);
            } catch (e) {
                failed++;
                this.log.warn(`sendTo fehlgeschlagen (${inst}): ${e.message}`);
            }
        }

        return { ok, failed, note: 'sent' };
    }

    async sendAvailableNotification(ctx) {
        const prefix = ctx.isTest ? 'TEST: ' : '';
        const details = ctx.freePorts !== undefined && ctx.portCount !== undefined ? ` (${ctx.freePorts}/${ctx.portCount})` : '';
        const text = `${prefix}Ladestation ${ctx.station} in ${ctx.city} ist nun frei${details}`;
        return this.sendMessageToChannels(text, ctx);
    }

    async notifySubscribers({ stationPrefixRel, city, stationName, freePorts, portCount, isTest = false }) {
        const subs = this.getSubscriptions();
        const matches = subs.filter((s) => {
            if (!s || !isTrue(s.enabled)) return false;
            const st = String(s.station || '').trim();
            if (!st) return false;
            if (st === '__ALL__') return true;
            if (st.startsWith('name:')) return String(stationName || '').toLowerCase() === st.replace(/^name:/, '').trim().toLowerCase();
            return st === String(stationPrefixRel);
        });

        // If no subscriptions exist, fall back to “all active channels” (keeps old behaviour)
        if (!matches.length) {
            return this.sendAvailableNotification({ isTest, station: stationName, city, freePorts, portCount });
        }

        for (const s of matches) {
            const recipientLabel = (s.recipient || '').toString().trim();
            if (!recipientLabel) continue;
            await this.sendAvailableNotification({
                isTest,
                station: stationName,
                city,
                freePorts,
                portCount,
                onlyLabel: recipientLabel,
            });
        }
        return { ok: matches.length, failed: 0, note: 'subscriptions' };
    }

    async sendTestNotifyForPrefix(stationPrefixRel) {
        const nameState = await this.getStateAsync(`${stationPrefixRel}.name`).catch(() => null);
        const cityState = await this.getStateAsync(`${stationPrefixRel}.city`).catch(() => null);
        const freePortsState = await this.getStateAsync(`${stationPrefixRel}.freePorts`).catch(() => null);
        const portCountState = await this.getStateAsync(`${stationPrefixRel}.portCount`).catch(() => null);

        const station = nameState?.val ? String(nameState.val) : stationPrefixRel.split('.').pop();
        const city = cityState?.val ? String(cityState.val) : stationPrefixRel.split('.')[1];
        const freePorts = freePortsState?.val !== undefined ? Number(freePortsState.val) : undefined;
        const portCount = portCountState?.val !== undefined ? Number(portCountState.val) : undefined;

        await this.notifySubscribers({ stationPrefixRel, city, stationName: station, freePorts, portCount, isTest: true });
    }

    // ---------- Objects ----------

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
        await this.setStateAsync('tools.testNotifyAll', { val: false, ack: true });
    }

    async ensureCarObjects() {
        await this.setObjectNotExistsAsync('car', { type: 'channel', common: { name: 'Auto' }, native: {} });
        await this.setObjectNotExistsAsync('car.lat', {
            type: 'state',
            common: { name: 'Auto Latitude', type: 'number', role: 'value.gps.latitude', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('car.lon', {
            type: 'state',
            common: { name: 'Auto Longitude', type: 'number', role: 'value.gps.longitude', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('car.soc', {
            type: 'state',
            common: { name: 'Auto Ladestand (SoC)', type: 'number', role: 'value.battery', unit: '%', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('car.source', {
            type: 'state',
            common: { name: 'Quelle (State-ID oder static)', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('car.lastUpdate', {
            type: 'state',
            common: { name: 'Letztes Update', type: 'string', role: 'date', read: true, write: false },
            native: {},
        });
    }

    async ensureNearestType2Objects() {
        await this.setObjectNotExistsAsync('nearestType2', { type: 'channel', common: { name: 'Nächste freie Typ2' }, native: {} });

        const mk = async (id, common) => this.setObjectNotExistsAsync(`nearestType2.${id}`, { type: 'state', common, native: {} });

        await mk('name', { name: 'Name', type: 'string', role: 'text', read: true, write: false });
        await mk('address', { name: 'Adresse', type: 'string', role: 'text', read: true, write: false });
        await mk('distance.m', { name: 'Distanz (m)', type: 'number', role: 'value.distance', unit: 'm', read: true, write: false });
        await mk('distance.km', { name: 'Distanz (km)', type: 'number', role: 'value.distance', unit: 'km', read: true, write: false });
        await mk('freePorts', { name: 'Freie Ports', type: 'number', role: 'value', read: true, write: false });
        await mk('portCount', { name: 'Ports gesamt', type: 'number', role: 'value', read: true, write: false });
        await mk('lat', { name: 'Latitude', type: 'number', role: 'value.gps.latitude', read: true, write: false });
        await mk('lon', { name: 'Longitude', type: 'number', role: 'value.gps.longitude', read: true, write: false });
        await mk('stationId', { name: 'Station ID', type: 'string', role: 'text', read: true, write: false });
        await mk('lastUpdate', { name: 'Letztes Update', type: 'string', role: 'date', read: true, write: false });
        await mk('lastError', { name: 'Letzter Fehler', type: 'string', role: 'text', read: true, write: false });
    }

    async initCarPosition() {
        // Prefer external state mapping if configured.
        // Static values are only used as fallback (e.g. initial value) if no external IDs are set or they are invalid/unavailable.
        const hasExternal = !!(this.carLatStateId || this.carLonStateId);

        // try to read foreign states (if configured)
        const lat = this.carLatStateId ? await this.getForeignStateAsync(this.carLatStateId).catch(() => null) : null;
        const lon = this.carLonStateId ? await this.getForeignStateAsync(this.carLonStateId).catch(() => null) : null;

        const latRaw = lat && lat.val !== undefined ? lat.val : undefined;
        const lonRaw = lon && lon.val !== undefined ? lon.val : undefined;
        const latN = latRaw !== undefined ? parseNumberLocale(latRaw) : NaN;
        const lonN = lonRaw !== undefined ? parseNumberLocale(lonRaw) : NaN;
        this.log.debug(`Auto init: latId='${this.carLatStateId}' val='${latRaw}' parsed=${latN}; lonId='${this.carLonStateId}' val='${lonRaw}' parsed=${lonN}`);
        if (Number.isFinite(latN) && Number.isFinite(lonN)) {
            this.carLat = latN;
            this.carLon = lonN;
            await this.setStateAsync('car.lat', { val: this.carLat, ack: true });
            await this.setStateAsync('car.lon', { val: this.carLon, ack: true });
            await this.setStateAsync('car.source', { val: `${this.carLatStateId || ''} | ${this.carLonStateId || ''}`.trim(), ack: true });
            await this.setStateAsync('car.lastUpdate', { val: new Date().toISOString(), ack: true });
            return;
        }

        // static values from config as fallback
        if (!hasExternal &&
            typeof this.carLatStatic === 'number' && Number.isFinite(this.carLatStatic) &&
            typeof this.carLonStatic === 'number' && Number.isFinite(this.carLonStatic)) {
            this.carLat = this.carLatStatic;
            this.carLon = this.carLonStatic;
            await this.setStateAsync('car.lat', { val: this.carLat, ack: true });
            await this.setStateAsync('car.lon', { val: this.carLon, ack: true });
            await this.setStateAsync('car.source', { val: 'static', ack: true });
            await this.setStateAsync('car.lastUpdate', { val: new Date().toISOString(), ack: true });
            return;
        }

        // If external IDs are configured but invalid right now, fall back to static if available
        if (hasExternal &&
            typeof this.carLatStatic === 'number' && Number.isFinite(this.carLatStatic) &&
            typeof this.carLonStatic === 'number' && Number.isFinite(this.carLonStatic)) {
            this.carLat = this.carLatStatic;
            this.carLon = this.carLonStatic;
            await this.setStateAsync('car.lat', { val: this.carLat, ack: true });
            await this.setStateAsync('car.lon', { val: this.carLon, ack: true });
            await this.setStateAsync('car.source', { val: 'static_fallback', ack: true });
            await this.setStateAsync('car.lastUpdate', { val: new Date().toISOString(), ack: true });
            return;
        }

        // No valid position found
        this.log.debug('Auto init: keine gültige Position (weder extern noch statisch)');
    }

    async initCarSoc() {
        if (!this.carSocStateId) return;
        const st = await this.getForeignStateAsync(this.carSocStateId).catch(() => null);
        const raw = st && st.val !== undefined ? st.val : undefined;
        const soc = raw !== undefined ? parseNumberLocale(raw) : NaN;
        this.log.debug(`Auto init SoC: socId='${this.carSocStateId}' val='${raw}' parsed=${soc}`);
        if (Number.isFinite(soc)) {
            this.carSoc = soc;
            await this.setStateAsync('car.soc', { val: soc, ack: true });
            await this.setStateAsync('car.lastUpdate', { val: new Date().toISOString(), ack: true });
        }

        // also refresh nearest type2 (SoC change can trigger notifications / relevance)
        this.scheduleNearestType2Update('socChange');
    }

    buildBBox(lat, lon, radiusM) {
        // Convert radius in meters to a bounding box (NE/SW) around the reference point.
        // The ChargePoint map endpoint expects a box, not a circle.
        // Use a slightly more precise meters-per-degree approximation.
        const metersPerDegLat = 111132; // ~ average
        const dLat = radiusM / metersPerDegLat;
        const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
        return {
            ne_lat: lat + dLat,
            ne_lon: lon + dLon,
            sw_lat: lat - dLat,
            sw_lon: lon - dLon,
        };
    }

    extractNearestType2(resData) {
        // Fast-path: expected response shape (what the browser shows)
        const arr = resData?.station_list?.stations;
        if (Array.isArray(arr) && arr.length) return arr[0];

        // Fallback: search for the first array of station-like objects
        const looksLikeStation = (o) =>
            o && typeof o === 'object' && (
                'station_name' in o || 'name' in o || 'name1' in o
            ) && (
                ('lat' in o && 'lon' in o) || ('latitude' in o && 'longitude' in o) || ('device_id' in o)
            );

        const seen = new Set();
        const queue = [resData];
        while (queue.length) {
            const cur = queue.shift();
            if (!cur) continue;

            if (Array.isArray(cur)) {
                if (cur.length && looksLikeStation(cur[0])) return cur[0];
                for (const it of cur) {
                    if (it && typeof it === 'object') queue.push(it);
                }
                continue;
            }

            if (typeof cur !== 'object') continue;
            if (seen.has(cur)) continue;
            seen.add(cur);

            for (const v of Object.values(cur)) {
                if (!v) continue;
                if (Array.isArray(v)) {
                    if (v.length && looksLikeStation(v[0])) return v[0];
                    queue.push(v);
                } else if (typeof v === 'object') {
                    queue.push(v);
                }
            }
        }
        return null;
    }

    async updateNearestType2(lat, lon) {
        // NOTE: A previous build accidentally inserted an invalid stray "(lat, lon) {" line here.
        // Keep this method as the only function header.
        if (!isTrue(this.config.nearestType2Enabled)) return;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const radiusM = Number(this.config.nearestRadiusM) || 2000;
        const pageSize = Number(this.config.nearestPageSize) || 10;
        const bbox = this.buildBBox(lat, lon, radiusM);

        const payload = {
            station_list: {
                screen_width: 1200,
                screen_height: 800,
                ne_lat: bbox.ne_lat,
                ne_lon: bbox.ne_lon,
                sw_lat: bbox.sw_lat,
                sw_lon: bbox.sw_lon,
                page_size: pageSize,
                page_offset: '',
                sort_by: 'distance',
                reference_lat: lat,
                reference_lon: lon,
                include_map_bound: true,
                filter: {
                    status_available: true,
                    connector_l2_type2: true,
                },
                bound_output: true,
            },
        };

        const url = 'https://mc.chargepoint.com/map-prod/v2?' + encodeURIComponent(JSON.stringify(payload));
        // Debug: URL und Payload loggen (zum Vergleich mit Browser-Link)
        this.log.debug('nearestType2 payload: ' + JSON.stringify(payload));
        this.log.info('nearestType2 URL: ' + url);
        this.log.debug(`nearestType2 bbox: NE(${bbox.ne_lat}, ${bbox.ne_lon}) SW(${bbox.sw_lat}, ${bbox.sw_lon}) r=${radiusM}m`);

        try {
            const resp = await axios.get(url, { timeout: 20000, validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0 (iobroker.cpt)', 'Accept': 'application/json,text/plain,*/*' } });
            if (resp.status < 200 || resp.status >= 300) {
                this.log.warn(`nearestType2: HTTP ${resp.status}`);
                await this.setStateAsync('nearestType2.lastError', { val: `HTTP ${resp.status}`, ack: true });
                return;
            }
            // Axios may return plain text even if it is JSON. Be robust.
            let data = resp.data;
            // In some setups axios returns a Buffer/ArrayBuffer.
            if (Buffer.isBuffer(data)) {
                try {
                    data = JSON.parse(data.toString('utf8'));
                } catch {
                    data = data.toString('utf8');
                }
            }
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                } catch {
                    // keep as-is
                }
            }

            // Debug: station count / shape
            const dbgStations = data?.station_list?.stations;
            if (Array.isArray(dbgStations)) {
                this.log.debug(`nearestType2: API returned ${dbgStations.length} stations`);
            } else {
                this.log.debug(`nearestType2: API shape unexpected, keys=${data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data}`);
            }

            // Prefer the known response shape: station_list.stations
            const stations = data?.station_list?.stations;
            let nearest = null;
            if (Array.isArray(stations) && stations.length) {
                // Compute distance locally (the API sometimes omits `distance`).
                let best = null;
                let bestM = Infinity;
                for (const st of stations) {
                    const stLat = parseNumberLocale(st?.lat ?? st?.latitude);
                    const stLon = parseNumberLocale(st?.lon ?? st?.longitude);
                    if (!Number.isFinite(stLat) || !Number.isFinite(stLon)) continue;
                    const km = this.haversineKm(lat, lon, stLat, stLon);
                    const m = km * 1000;
                    if (m < bestM) {
                        bestM = m;
                        best = st;
                    }
                }
                nearest = best || stations[0];
                if (Number.isFinite(bestM) && bestM !== Infinity) {
                    // attach computed distance for later state writing
                    nearest.__distanceM = bestM;
                }
            } else {
                nearest = this.extractNearestType2(data);
            }
            await this.setStateAsync('nearestType2.lastError', { val: '', ack: true });
            if (!nearest) {
                this.log.info('nearestType2: keine Treffer');
                await this.setStateAsync('nearestType2.lastError', { val: 'keine Treffer', ack: true });
                return;
            }

            const name = nearest.station_name || nearest.name || nearest.name1 || '';

            // Build a more complete address (street + zip + city) if available
            const a1 = (nearest.address1 || nearest.address || nearest.street_address || nearest.location || '').toString().trim();
            const a2 = (nearest.address2 || nearest.address_2 || '').toString().trim();
            const zip = (nearest.postal_code || nearest.zip || nearest.postalCode || nearest.postcode || '').toString().trim();
            const city = (nearest.city || nearest.town || '').toString().trim();
            const region = (nearest.state || nearest.region || '').toString().trim();
            const country = (nearest.country || nearest.country_code || '').toString().trim();

            const line2Parts = [];
            const zipCity = [zip, city].filter(Boolean).join(' ').trim();
            if (zipCity) line2Parts.push(zipCity);
            if (region && !zipCity.includes(region)) line2Parts.push(region);
            if (country && !line2Parts.join(' ').includes(country)) line2Parts.push(country);

            const address = [a1, a2, line2Parts.join(', ')].filter(Boolean).join(', ');
            let distM = parseNumberLocale(nearest.__distanceM ?? nearest.distance ?? nearest.distance_m ?? nearest.distanceMeters ?? nearest.distance_meters);
            const stLat = parseNumberLocale(nearest.lat ?? nearest.latitude);
            const stLon = parseNumberLocale(nearest.lon ?? nearest.longitude);
            if (!Number.isFinite(distM) && Number.isFinite(stLat) && Number.isFinite(stLon)) {
                // compute haversine distance (meters)
                const R = 6371000;
                const toRad = (x) => (x * Math.PI) / 180;
                const dLat = toRad(stLat - lat);
                const dLon = toRad(stLon - lon);
                const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(stLat)) * Math.sin(dLon / 2) ** 2;
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                distM = R * c;
            }
            const latS = parseNumberLocale(nearest.lat ?? nearest.latitude);
            const lonS = parseNumberLocale(nearest.lon ?? nearest.longitude);
            const portsArr = Array.isArray(nearest.ports) ? nearest.ports : [];
            const freePorts = Number.isFinite(parseNumberLocale(nearest.free_ports ?? nearest.freePorts))
                ? parseNumberLocale(nearest.free_ports ?? nearest.freePorts)
                : portsArr.filter(p => String(p?.status_v2 ?? p?.statusV2 ?? p?.status).toLowerCase() === 'available').length;
            const portCount = Number.isFinite(parseNumberLocale(nearest.total_port_count ?? nearest.portCount))
                ? parseNumberLocale(nearest.total_port_count ?? nearest.portCount)
                : (Number.isFinite(parseNumberLocale(nearest.total_port_count)) ? parseNumberLocale(nearest.total_port_count) : portsArr.length);
            const stationId = String(nearest.device_id ?? nearest.station_id ?? nearest.id ?? '').trim();

            if (name) await this.setStateAsync('nearestType2.name', { val: name, ack: true });
            await this.setStateAsync('nearestType2.address', { val: address || '', ack: true });
            if (Number.isFinite(distM)) {
                await this.setStateAsync('nearestType2.distance.m', { val: Math.round(distM), ack: true });
                await this.setStateAsync('nearestType2.distance.km', { val: Math.round((distM / 1000) * 100) / 100, ack: true });
            }
            if (Number.isFinite(freePorts)) await this.setStateAsync('nearestType2.freePorts', { val: Math.round(freePorts), ack: true });
            if (Number.isFinite(portCount)) await this.setStateAsync('nearestType2.portCount', { val: Math.round(portCount), ack: true });
            if (Number.isFinite(latS)) await this.setStateAsync('nearestType2.lat', { val: latS, ack: true });
            if (Number.isFinite(lonS)) await this.setStateAsync('nearestType2.lon', { val: lonS, ack: true });
            await this.setStateAsync('nearestType2.stationId', { val: stationId, ack: true });
            await this.setStateAsync('nearestType2.lastUpdate', { val: new Date().toISOString(), ack: true });
        } catch (e) {
            this.log.debug(`nearestType2 Fehler: ${e.message}`);
        }
    }

    async updateCarSoc(soc, source) {
        const socN = parseNumberLocale(soc);
        if (!Number.isFinite(socN)) return;
        this.carSoc = socN;
        await this.setStateAsync('car.soc', { val: socN, ack: true });
        if (source) {
            // Keep car.source focused on mapping info
            await this.setStateAsync('car.source', { val: source, ack: true });
        }
        await this.setStateAsync('car.lastUpdate', { val: new Date().toISOString(), ack: true });
        await this.handleCarContextChange('socChange');
    }

    async passesNotifyFilters(stationPrefixRel) {
        const res = { ok: true, socOk: true, distanceOk: true, soc: this.carSoc, distanceM: null };

        const socTh = Number(this.notifySocBelow);
        if (Number.isFinite(socTh)) {
            if (typeof this.carSoc !== 'number' || !Number.isFinite(this.carSoc)) {
                res.ok = false;
                res.socOk = false;
            } else {
                res.socOk = this.carSoc < socTh;
                res.ok = res.ok && res.socOk;
            }
        }

        const distMax = Number(this.notifyMaxDistanceM);
        if (Number.isFinite(distMax)) {
            const st = await this.getStateAsync(`${stationPrefixRel}.distance.m`).catch(() => null);
            const d = st && st.val !== undefined && st.val !== null ? Number(st.val) : NaN;
            res.distanceM = Number.isFinite(d) ? d : null;
            if (!Number.isFinite(d)) {
                res.ok = false;
                res.distanceOk = false;
            } else {
                res.distanceOk = d <= distMax;
                res.ok = res.ok && res.distanceOk;
            }
        }

        return res;
    }


    getNotifyMeta(stationPrefixRel) {
        if (!this.notifyMetaByStation[stationPrefixRel]) {
            this.notifyMetaByStation[stationPrefixRel] = { inRange: false, notified: false, lastSent: 0 };
        }
        return this.notifyMetaByStation[stationPrefixRel];
    }

    getExitDistanceM() {
        const enter = Number(this.notifyMaxDistanceM);
        if (!Number.isFinite(enter) || enter <= 0) return null;
        return Math.round(enter * 1.1); // 500 -> 550
    }

    async computeInRange(stationPrefixRel) {
        const meta = this.getNotifyMeta(stationPrefixRel);
        const enter = Number(this.notifyMaxDistanceM);
        const exit = this.getExitDistanceM();

        const st = await this.getStateAsync(`${stationPrefixRel}.distance.m`).catch(() => null);
        const d = st && st.val !== undefined && st.val !== null ? Number(st.val) : NaN;
        if (!Number.isFinite(d)) {
            // If we cannot determine distance, treat as out of range
            const prev = meta.inRange;
            meta.inRange = false;
            return { prev, now: false, entered: false, exited: prev, distanceM: null };
        }

        const prev = meta.inRange;
        let now = prev;

        if (prev) {
            if (Number.isFinite(exit) && d >= exit) now = false;
        } else {
            if (Number.isFinite(enter) && d <= enter) now = true;
        }

        meta.inRange = now;
        return { prev, now, entered: !prev && now, exited: prev && !now, distanceM: d };
    }

    stationHasNotifyTarget(stationPrefixRel, stationName) {
        const subs = this.getSubscriptions();
        const hasSubs = subs.some((s) => {
            if (!s || !isTrue(s.enabled)) return false;
            const stVal = String(s.station || '').trim();
            if (!stVal) return false;
            if (stVal === '__ALL__') return true;
            if (stVal.startsWith('name:')) return String(stationName || '').toLowerCase() === stVal.replace(/^name:/, '').trim().toLowerCase();
            return stVal === String(stationPrefixRel);
        });
        return hasSubs;
    }

    async attemptNotifyForStation({ stationPrefixRel, city, stationName, freePorts, portCount, reason }) {
        const meta = this.getNotifyMeta(stationPrefixRel);

        // Reset notified when station is not free anymore
        if (!(Number(freePorts) > 0)) {
            meta.notified = false;
            return;
        }

        // Only one notification per "free phase"
        if (meta.notified) return;

        // Cooldown (per station)
        const cdMin = Number(this.notifyCooldownMin) || 0;
        if (cdMin > 0 && meta.lastSent && Date.now() - meta.lastSent < cdMin * 60 * 1000) {
            return;
        }

        // Station toggle OR subscriptions decide whether station is relevant
        const notifyState = await this.getStateAsync(`${stationPrefixRel}.notifyOnAvailable`).catch(() => null);
        const notifyEnabled = notifyState?.val === true;
        const hasSubs = this.stationHasNotifyTarget(stationPrefixRel, stationName);

        if (!notifyEnabled && !hasSubs) return;

        // Filters: SoC + distance must be determinable and pass
        const f = await this.passesNotifyFilters(stationPrefixRel);
        if (!f.ok) {
            const reasons = [];
            if (!f.socOk) reasons.push(`SoC nicht unter ${this.notifySocBelow}% (SoC=${f.soc ?? 'n/a'})`);
            if (!f.distanceOk) reasons.push(`Distanz > ${this.notifyMaxDistanceM}m (dist=${f.distanceM ?? 'n/a'})`);
            this.log.debug(`Notify übersprungen (${reason}): ${stationName} (${city}) – ${reasons.join(', ')}`);
            return;
        }

        await this.notifySubscribers({ stationPrefixRel, city, stationName, freePorts, portCount, isTest: false });
        meta.notified = true;
        meta.lastSent = Date.now();
        this.log.info(`Notify (${reason}): ${stationName} (${city}) freePorts=${freePorts}/${portCount} (SoC=${f.soc ?? 'n/a'}%, dist=${f.distanceM ?? 'n/a'}m)`);
    }

    
    async ensureStationObjects(stationPrefix, station, cityName) {
        await this.setObjectNotExistsAsync(stationPrefix, { type: 'channel', common: { name: station.name }, native: {} });

        const states = [
            ['name', { name: 'Name', type: 'string', role: 'text', read: true, write: false }],
            ['city', { name: 'Ort', type: 'string', role: 'text', read: true, write: false }],
            ['deviceId1', { name: 'Device ID (P1)', type: 'string', role: 'value', read: true, write: false }],
            ['deviceId2', { name: 'Device ID (P2)', type: 'string', role: 'value', read: true, write: false }],
            ['enabled', { name: 'Aktiv', type: 'boolean', role: 'indicator', read: true, write: false }],
            ['notifyOnAvailable', { name: 'Benachrichtigen wenn verfügbar', type: 'boolean', role: 'switch', read: true, write: true, def: false }],
            ['testNotify', { name: 'Test: Notify (Button)', type: 'boolean', role: 'button', read: true, write: true, def: false }],
            ['statusDerived', { name: 'Status (aus Ports)', type: 'string', role: 'value', read: true, write: false }],
            ['statusAgeMin', { name: 'Status seit (Minuten)', type: 'number', role: 'value.interval', unit: 'min', read: true, write: false }],
            ['portCount', { name: 'Anzahl Ports', type: 'number', role: 'value', read: true, write: false }],
            ['freePorts', { name: 'Freie Ports', type: 'number', role: 'value', read: true, write: false }],
            ['lastUpdate', { name: 'Letztes Update', type: 'string', role: 'date', read: true, write: false }],
        ];

        for (const [id, common] of states) {
            await this.setObjectNotExistsAsync(`${stationPrefix}.${id}`, { type: 'state', common, native: {} });
        }

        await this.setObjectNotExistsAsync(`${stationPrefix}.gps`, { type: 'channel', common: { name: 'GPS' }, native: {} });
        await this.setObjectNotExistsAsync(`${stationPrefix}.gps.lat`, {
            type: 'state',
            common: { name: 'Latitude', type: 'number', role: 'value.gps.latitude', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${stationPrefix}.gps.lon`, {
            type: 'state',
            common: { name: 'Longitude', type: 'number', role: 'value.gps.longitude', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${stationPrefix}.gps.json`, {
            type: 'state',
            common: { name: 'GPS (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.distance`, { type: 'channel', common: { name: 'Entfernung' }, native: {} });
        await this.setObjectNotExistsAsync(`${stationPrefix}.distance.km`, {
            type: 'state',
            common: { name: 'Entfernung (km)', type: 'number', role: 'value.distance', unit: 'km', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${stationPrefix}.distance.m`, {
            type: 'state',
            common: { name: 'Entfernung (m)', type: 'number', role: 'value.distance', unit: 'm', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.ports`, { type: 'channel', common: { name: 'Ports' }, native: {} });

        await this.setStateAsync(`${stationPrefix}.name`, { val: String(station.name || ''), ack: true });
        await this.setStateAsync(`${stationPrefix}.city`, { val: String(cityName || ''), ack: true });
        await this.setStateAsync(`${stationPrefix}.deviceId1`, { val: String(station.deviceId1 ?? ''), ack: true });
        await this.setStateAsync(`${stationPrefix}.deviceId2`, { val: station.deviceId2 ? String(station.deviceId2) : '', ack: true });
        await this.setStateAsync(`${stationPrefix}.enabled`, { val: !!station.enabled, ack: true });

        const curNotify = await this.getStateAsync(`${stationPrefix}.notifyOnAvailable`).catch(() => null);
        if (!curNotify || curNotify.val === null || curNotify.val === undefined) {
            await this.setStateAsync(`${stationPrefix}.notifyOnAvailable`, { val: !!station.notifyOnAvailable, ack: true });
        }
    }

    async ensurePortObjects(stationPrefix, outletNumber) {
        const portPrefix = `${stationPrefix}.ports.${outletNumber}`;
        await this.setObjectNotExistsAsync(portPrefix, { type: 'channel', common: { name: `Port ${outletNumber}` }, native: {} });

        const states = [
            ['status', { name: 'Status', type: 'string', role: 'value' }],
            ['statusV2', { name: 'StatusV2', type: 'string', role: 'value' }],
            ['evseId', { name: 'EVSE ID', type: 'string', role: 'value' }],
            ['maxPowerKw', { name: 'Max Power', type: 'number', role: 'value.power', unit: 'kW' }],
            ['displayPlugType', { name: 'Plug', type: 'string', role: 'text' }],
            ['lastUpdate', { name: 'Letztes Update', type: 'string', role: 'date' }],
        ];

        for (const [id, common] of states) {
            await this.setObjectNotExistsAsync(`${portPrefix}.${id}`, { type: 'state', common: { read: true, write: false, ...common }, native: {} });
        }

        return portPrefix;
    }

    // ---------- ChargePoint API ----------

    async safeFetch(deviceId) {
        try {
            const url = `https://mc.chargepoint.com/map-prod/v3/station/info?deviceId=${deviceId}`;
            this.log.debug(`GET ${url}`);
            const res = await axios.get(url, { timeout: 12000 });
            return res.data || {};
        } catch (e) {
            this.log.warn(`Fetch fehlgeschlagen für deviceId=${deviceId}: ${e.message}`);
            return null;
        }
    }

    buildLogicalPorts(data1, data2, hasSecondId) {
        if (hasSecondId) {
            const p1 = data1?.portsInfo?.ports?.[0] || {};
            const p2 = data2?.portsInfo?.ports?.[0] || {};
            return [{ ...p1, outletNumber: 1 }, { ...p2, outletNumber: 2 }];
        }
        return Array.isArray(data1?.portsInfo?.ports) ? data1.portsInfo.ports : [];
    }

    async updateAllStations(stations) {
        const currentPrefixes = new Set();
        for (const st of stations) {
            const data1 = await this.safeFetch(st.deviceId1);
            const data2 = st.deviceId2 ? await this.safeFetch(st.deviceId2) : null;

            const city = this.pickCity(data1, data2);
            const cityKey = this.makeSafeName(city) || 'unbekannt';
            const stationKey = this.getStationKey(st);
            const stationPrefix = `stations.${cityKey}.${stationKey}`;
            currentPrefixes.add(stationPrefix);

            this.stationPrefixByName[st.name] = stationPrefix;

            await this.ensureCityChannel(`stations.${cityKey}`, city);
            await this.ensureStationObjects(stationPrefix, st, city);

                        // remember station prefixes for car-trigger notifications
            if (!this.stationPrefixes.includes(stationPrefix)) this.stationPrefixes.push(stationPrefix);
            this.stationInfoByPrefix[stationPrefix] = { city, name: st.name };

            const gps = this.extractGps(data1, data2);
            if (gps) {
                await this.updateStateIfChanged(`${stationPrefix}.gps.lat`, gps.lat);
                await this.updateStateIfChanged(`${stationPrefix}.gps.lon`, gps.lon);
                await this.updateStateIfChanged(`${stationPrefix}.gps.json`, JSON.stringify(gps));
            }

            // distance from car (if available)
            await this.updateDistanceForStation(stationPrefix, gps);

            if (st.enabled === false) {
                await this.updateStateIfChanged(`${stationPrefix}.statusDerived`, 'deaktiviert');
                await this.updateStatusAgeMin(stationPrefix);
                await this.updateStateIfChanged(`${stationPrefix}.portCount`, 0);
                await this.updateStateIfChanged(`${stationPrefix}.freePorts`, 0);
                await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
                continue;
            }

            const ports = this.buildLogicalPorts(data1, data2, !!st.deviceId2);
            const portCount = st.deviceId2 ? 2 : ports.length;
            const freePorts = ports.reduce((acc, p) => acc + (this.normalizeStatus(p?.statusV2 || p?.status) === 'available' ? 1 : 0), 0);
            const derived = this.deriveStationStatusFromPorts(ports);

            const prevFree = this.lastFreePortsByStation[stationPrefix];

            await this.updateStateIfChanged(`${stationPrefix}.portCount`, portCount);
            await this.updateStateIfChanged(`${stationPrefix}.freePorts`, freePorts);
            await this.updateStateIfChanged(`${stationPrefix}.statusDerived`, derived);
            await this.updateStatusAgeMin(stationPrefix);
            await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });

            // ports
            for (let i = 0; i < ports.length; i++) {
                const port = ports[i] || {};
                const outletNumber = port.outletNumber ?? i + 1;
                const portPrefix = await this.ensurePortObjects(stationPrefix, outletNumber);

                const connector0 = Array.isArray(port.connectorList) && port.connectorList.length ? port.connectorList[0] : null;
                const displayPlugType = connector0?.displayPlugType ? String(connector0.displayPlugType) : '';

                await this.updateStateIfChanged(`${portPrefix}.status`, port.status || 'unknown');
                await this.updateStateIfChanged(`${portPrefix}.statusV2`, port.statusV2 || 'unknown');
                await this.updateStateIfChanged(`${portPrefix}.evseId`, port.evseId ? String(port.evseId) : '');

                const prMax = port?.powerRange?.max;
                const maxPowerKw = typeof prMax === 'number' ? prMax : prMax !== undefined ? Number(prMax) : NaN;
                if (!Number.isNaN(maxPowerKw)) await this.updateStateIfChanged(`${portPrefix}.maxPowerKw`, maxPowerKw);

                await this.updateStateIfChanged(`${portPrefix}.displayPlugType`, displayPlugType);
                await this.setStateAsync(`${portPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
            }

            // notify logic:
            // 1) station becomes free (0 -> >0) and car is already in range with low SoC
            // 2) car enters range / SoC drops is handled on car state changes
            const meta = this.getNotifyMeta(stationPrefix);

            // reset notification when station is not free anymore
            if (!(Number(freePorts) > 0)) {
                meta.notified = false;
            }

            if (prevFree !== undefined && Number(prevFree) === 0 && Number(freePorts) > 0) {
                await this.attemptNotifyForStation({
                    stationPrefixRel: stationPrefix,
                    city,
                    stationName: st.name,
                    freePorts,
                    portCount,
                    reason: 'stationFree',
                });
            }

            this.lastFreePortsByStation[stationPrefix] = freePorts;

            this.scheduleVisHtmlUpdate('state change');

            this.log.debug(`Aktualisiert: ${st.name} city=${city} freePorts=${freePorts}/${portCount} derived=${derived}`);
        }

        this.scheduleVisHtmlUpdate('poll finished');
        this.scheduleNearestType2Update('poll finished');
        // remove objects for stations that were removed from config
        await this.cleanupObsoleteStations(currentPrefixes);

    }

    async updateDistanceForStation(stationPrefixRel, gps) {
        try {
            if (!gps || gps.lat === undefined || gps.lon === undefined) return;
            const latCar = this.carLat;
            const lonCar = this.carLon;
            if (typeof latCar !== 'number' || typeof lonCar !== 'number') {
                // clear distance if previously set
                await this.updateStateIfChanged(`${stationPrefixRel}.distance.km`, null);
                await this.updateStateIfChanged(`${stationPrefixRel}.distance.m`, null);
                return;
            }
            const km = this.haversineKm(latCar, lonCar, Number(gps.lat), Number(gps.lon));
            if (!Number.isFinite(km)) return;
            const m = Math.round(km * 1000);
            const kmRound = Math.round(km * 100) / 100;
            await this.updateStateIfChanged(`${stationPrefixRel}.distance.km`, kmRound);
            await this.updateStateIfChanged(`${stationPrefixRel}.distance.m`, m);
        } catch (e) {
            this.log.debug(`Distanzberechnung fehlgeschlagen (${stationPrefixRel}): ${e.message}`);
        }
    }
    
async cleanupObsoleteStations(currentPrefixes) {
    // currentPrefixes: Set of rel station prefixes like "stations.<cityKey>.<stationKey>"
    try {
        const nameStates = await this.getStatesAsync(this.namespace + '.stations.*.*.name');
        const prefixesExisting = new Set();

        for (const id of Object.keys(nameStates || {})) {
            // id looks like "cpt.0.stations.<city>.<station>.name"
            const rel = id.replace(this.namespace + '.', '').replace(/\.name$/, '');
            prefixesExisting.add(rel);
        }

        // Delete station channels (and their states) that are no longer in current config
        for (const relPrefix of prefixesExisting) {
            if (!currentPrefixes.has(relPrefix)) {
                this.log.info(`Removing obsolete station objects: ${relPrefix}`);
                await this.delObjectAsync(relPrefix, { recursive: true });
            }
        }

        // Delete empty city channels (stations.<cityKey>) when no remaining station uses them
        const usedCities = new Set();
        for (const relPrefix of currentPrefixes) {
            const parts = relPrefix.split('.');
            // stations.<cityKey>.<stationKey>
            if (parts.length >= 3 && parts[0] === 'stations') usedCities.add(parts[1]);
        }

        const startkey = this.namespace + '.stations.';
        const endkey = this.namespace + '.stations.\\u9999';

        // Prefer async API to avoid "await" in callbacks (Node 20 strict mode)
        const res = await this.getObjectViewAsync('system', 'channel', { startkey, endkey }).catch(() => null);
        if (res && res.rows) {
            for (const row of res.rows) {
                const id = row.id || '';
                const rel = id.replace(this.namespace + '.', '');
                const parts = rel.split('.');
                if (parts.length === 2 && parts[0] === 'stations') {
                    const cityKey = parts[1];
                    if (!usedCities.has(cityKey)) {
                        this.log.info(`Removing obsolete city channel: ${rel}`);
                        await this.delObjectAsync(rel, { recursive: true });
                    }
                }
            }
        }
    } catch (e) {
        this.log.warn(`cleanupObsoleteStations failed: ${e && e.message ? e.message : e}`);
    }
}



    async updateDistancesForAllStations() {
        try {
            const list = await this.getStatesAsync(this.namespace + '.stations.*.*.gps.json');
            for (const [id, st] of Object.entries(list || {})) {
                const relPrefix = id.replace(this.namespace + '.', '').replace(/\.gps\.json$/, '');
                let gps;
                try {
                    gps = st?.val ? JSON.parse(String(st.val)) : null;
                } catch {
                    gps = null;
                }
                if (gps) await this.updateDistanceForStation(relPrefix, gps);
            }
            this.scheduleVisHtmlUpdate('car distance change');
        } catch (e) {
            this.log.debug(`updateDistancesForAllStations fehlgeschlagen: ${e.message}`);
        }
    }


    async handleCarContextChange(reason = 'car') {
        try {
            if (!Array.isArray(this.stationPrefixes) || !this.stationPrefixes.length) return;

            // Only proceed if we have a valid SoC (mandatory)
            if (typeof this.carSoc !== 'number' || !Number.isFinite(this.carSoc)) return;

            for (const prefix of this.stationPrefixes) {
                // station must currently be free
                const freeSt = await this.getStateAsync(`${prefix}.freePorts`).catch(() => null);
                const freePorts = freeSt?.val !== undefined ? Number(freeSt.val) : NaN;
                if (!Number.isFinite(freePorts) || freePorts <= 0) {
                    // reset notified when not free (so next free cycle can notify)
                    this.getNotifyMeta(prefix).notified = false;
                    continue;
                }

                // compute in-range transition
                const range = await this.computeInRange(prefix);
                const meta = this.getNotifyMeta(prefix);

                // If we just entered, or SoC got low while already inside range, try notify
                const shouldTry = range.entered || (range.now && reason === 'socChange');

                if (!shouldTry) continue;

                // Need station context
                const info = this.stationInfoByPrefix[prefix] || {};
                const portCountSt = await this.getStateAsync(`${prefix}.portCount`).catch(() => null);
                const portCount = portCountSt?.val !== undefined ? Number(portCountSt.val) : undefined;

                await this.attemptNotifyForStation({
                    stationPrefixRel: prefix,
                    city: info.city || prefix.split('.')[1] || '',
                    stationName: info.name || prefix.split('.').pop(),
                    freePorts,
                    portCount,
                    reason: range.entered ? 'carEntered' : 'socBelow',
                });

                // If we left range, we do NOT reset meta.notified (one notify per free-phase)
                if (range.exited) {
                    meta.inRange = false;
                }
            }
        } catch (e) {
            this.log.debug(`handleCarContextChange failed: ${e.message}`);
        }
    }

    // ---------- ioBroker lifecycle ----------

    
    // ---------- VIS HTML (server side) ----------
    scheduleVisHtmlUpdate(reason = '') {
        if (!this.visHtmlEnabled && !this.visHtmlMobileEnabled) return;
        if (this.visHtmlTimer) clearTimeout(this.visHtmlTimer);
        this.visHtmlTimer = setTimeout(() => {
            if (this.visHtmlEnabled) {
                this.writeVisHtmlObject().catch((e) => this.log.warn(`VIS HTML Update fehlgeschlagen: ${e.message}`));
            }
            if (this.visHtmlMobileEnabled) {
                this.writeVisHtmlMobileObject().catch((e) => this.log.warn(`VIS HTML Mobile Update fehlgeschlagen: ${e.message}`));
            }
        }, this.visHtmlDebounceMs);
        if (reason) this.log.debug(`VIS HTML Update geplant: ${reason}`);
    }

    scheduleNearestType2Update(reason = '') {
        if (!isTrue(this.config.nearestType2Enabled)) return;
        if (!Number.isFinite(this.carLat) || !Number.isFinite(this.carLon)) return;
        if (this.nearestTimer) clearTimeout(this.nearestTimer);
        this.nearestTimer = setTimeout(() => {
            this.updateNearestType2(this.carLat, this.carLon)
                .catch((e) => this.log.debug(`nearestType2 Update fehlgeschlagen: ${e.message}`));
        }, this.nearestDebounceMs);
        if (reason) this.log.debug(`nearestType2 Update geplant: ${reason}`);
    }

    async ensureVisHtmlObject() {
        if (!this.visHtmlEnabled) return;
        const id = this.visHtmlObjectId;
        try {
            const obj = await this.getForeignObjectAsync(id);
            if (!obj) {
                await this.setForeignObjectAsync(id, {
                    _id: id,
                    type: 'state',
                    common: {
                        name: 'ChargePoint VIS HTML (Stationen + Ports)',
                        type: 'string',
                        role: 'html',
                        read: true,
                        write: true,
                    },
                    native: {},
                });
            }
        } catch (e) {
            this.log.warn(`Konnte VIS HTML Objekt nicht anlegen (${id}): ${e.message}`);
        }
    }


    async ensureVisHtmlMobileObject() {
        if (!this.visHtmlMobileEnabled) return;
        const id = this.visHtmlMobileObjectId;
        try {
            const obj = await this.getForeignObjectAsync(id);
            if (!obj) {
                await this.setForeignObjectAsync(id, {
                    _id: id,
                    type: 'state',
                    common: {
                        name: 'ChargePoint VIS HTML (Mobile)',
                        type: 'string',
                        role: 'html',
                        read: true,
                        write: true,
                    },
                    native: {},
                });
            }
        } catch (e) {
            this.log.warn(`Konnte VIS HTML Mobile Objekt nicht anlegen (${id}): ${e.message}`);
        }
    }

    async writeVisHtmlMobileObject() {
        if (!this.visHtmlMobileEnabled) return;
        const id = this.visHtmlMobileObjectId;

        const root = this.namespace + '.stations.';
        const all = await this.getStatesAsync(root + '*');

        const prefixesAll = Object.keys(all || {})
            .filter((k) => k.endsWith('.name') && all[k] && all[k].val !== undefined)
            .map((k) => k.replace(this.namespace + '.', '').replace(/\.name$/, ''))
            .sort((a, b) => a.localeCompare(b));

        // Only show active stations in VIS (enabled in config)
        const prefixes = prefixesAll.filter((p) => {
            const en = all[this.namespace + '.' + p + '.enabled']?.val;
            return en === true;
        });

        const html = this.renderStationsHtmlMobile(prefixes, all);
        await this.ensureVisHtmlMobileObject();
        await this.setForeignStateAsync(id, { val: html, ack: true });
    }

    
    renderStationsHtmlMobile(prefixes, allStates) {
        const esc = (v) => (v === null || v === undefined) ? '' : String(v)
            .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

        const badge = (text, kind) => {
            const styles = {
                ok:      'background:rgba(46,204,113,.18); border:1px solid rgba(46,204,113,.45);',
                warn:    'background:rgba(241,196,15,.18); border:1px solid rgba(241,196,15,.45);',
                bad:     'background:rgba(231,76,60,.18);  border:1px solid rgba(231,76,60,.45);',
                neutral: 'background:rgba(255,255,255,.10); border:1px solid rgba(255,255,255,.18);',
            };
            const st = styles[kind] || styles.neutral;
            return `<span style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;font-size:13px;font-weight:700;white-space:nowrap;${st}">${esc(text)}</span>`;
        };

        const portDot = (kind) => {
            const map = {
                ok: '#2ecc71',
                bad: '#e74c3c',
                neutral: 'rgba(255,255,255,.45)',
            };
            const c = map[kind] || map.neutral;
            return `<span style="font-size:20px;line-height:1;color:${c};margin-right:6px;">●</span>`;
        };

        const getVal = (relId) => {
            const full = this.namespace + '.' + relId;
            const st = allStates[full];
            return st ? st.val : undefined;
        };

        const updated = new Date().toLocaleString('de-DE');
        let out = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;font-size:16px;">
  <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:10px;">
    <div style="font-weight:900;font-size:18px;">⚡ ChargePoint</div>
    <div style="opacity:.7;font-size:12px;">${esc(updated)}</div>
  </div>
  <div style="display:flex;flex-direction:column;gap:10px;">
`;

        if (!prefixes.length) {
            out += `<div style="padding:12px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:rgba(0,0,0,.18);">Keine Stationsdaten gefunden.</div>`;
            out += `</div></div>`;
            return out;
        }

        for (const p of prefixes) {
            const name = getVal(p + '.name') ?? p.split('.').pop();
            const city = getVal(p + '.city') ?? '';

            const freePorts = getVal(p + '.freePorts');
            const portCount = getVal(p + '.portCount');

            // Station status (Deutsch, verständlich)
            let stationStatus = 'Unbekannt';
            let stationKind = 'neutral';
            if (freePorts !== undefined && freePorts !== null && freePorts !== '') {
                const fp = Number(freePorts);
                if (!Number.isNaN(fp)) {
                    if (fp > 0) {
                        stationStatus = 'Frei';
                        stationKind = 'ok';
                    } else {
                        stationStatus = 'Belegt';
                        stationKind = 'bad';
                    }
                }
            }

            const portsText = (freePorts !== undefined && freePorts !== null && freePorts !== '' &&
                portCount !== undefined && portCount !== null && portCount !== '')
                ? `Ports: ${esc(freePorts)} / ${esc(portCount)} frei`
                : '';

            const ageMin = getVal(p + '.statusAgeMin');
            const ageText = (ageMin !== undefined && ageMin !== null && ageMin !== '')
                ? `seit ${esc(ageMin)} min`
                : '';

            // Ports (Variante 1 + 2)
            let dotsHtml = '';
            let portsDetailText = '';
            const pc = (portCount !== undefined && portCount !== null && portCount !== '') ? Number(portCount) : NaN;

            if (!Number.isNaN(pc) && pc > 0) {
                const parts = [];
                for (let i = 1; i <= pc; i++) {
                    const s2 = getVal(p + `.ports.${i}.statusV2`);
                    const s1 = getVal(p + `.ports.${i}.status`);
                    const raw = (s2 ?? s1 ?? 'unknown');

                    const norm = String(raw || 'unknown').toLowerCase();
                    const isFree = norm.includes('available') || norm.includes('frei');
                    const isUnknown = norm === 'unknown' || norm === '' || norm.includes('unavailable') && !isFree;

                    const kind = isFree ? 'ok' : (isUnknown ? 'neutral' : 'bad');
                    dotsHtml += portDot(kind);

                    parts.push(`P${i} ${isFree ? 'frei' : 'belegt'}`);
                }
                portsDetailText = parts.join(' · ');
            }

            out += `
    <div style="border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(0,0,0,.18);box-shadow:0 10px 24px rgba(0,0,0,.22);padding:12px 14px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
        <div style="min-width:0;">
          <div style="font-weight:850;font-size:17px;line-height:1.15;">${esc(name)}</div>
          <div style="opacity:.75;font-size:13px;margin-top:2px;">${esc(city)}</div>

          <div style="margin-top:8px;">${badge(stationStatus, stationKind)}</div>

        </div>
        <div style="width:180px;text-align:right;padding-top:2px;">
          ${portsText ? `<div style="opacity:.9;font-size:12px;font-weight:800;">${portsText}</div>` : ''}
          ${dotsHtml ? `<div style="margin-top:6px;line-height:1;">${dotsHtml}</div>` : ''}
          ${portsDetailText ? `<div style="opacity:.8;font-size:11px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(portsDetailText)}</div>` : ''}
          ${ageText ? `<div style="opacity:.65;font-size:11px;margin-top:6px;">${ageText}</div>` : ''}
        </div>
      </div>
    </div>
`;
        }

        out += `
  </div>
</div>
`;
        return out;
    }


    async writeVisHtmlObject() {
        if (!this.visHtmlEnabled) return;
        const id = this.visHtmlObjectId;

        const root = this.namespace + '.stations.';
        const all = await this.getStatesAsync(root + '*');

        const prefixesAll = Object.keys(all || {})
            .filter((k) => k.endsWith('.name') && all[k] && all[k].val !== undefined)
            .map((k) => k.replace(this.namespace + '.', '').replace(/\.name$/, ''))
            .sort((a, b) => a.localeCompare(b));

        // Only show active stations in VIS (filter out disabled stations marked as 'deaktiviert')
        const prefixes = prefixesAll.filter((p) => {
            const en = all[this.namespace + '.' + p + '.enabled']?.val;
            return en === true;
        });

        const html = this.renderStationsHtml(prefixes, all);
        await this.ensureVisHtmlObject();
        await this.setForeignStateAsync(id, { val: html, ack: true });
    }

    renderStationsHtml(prefixes, allStates) {
        const esc = (v) => (v === null || v === undefined) ? '' : String(v)
            .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

        const badge = (text, kind) => {
            const styles = {
                ok:      'background:rgba(46,204,113,.18); border:1px solid rgba(46,204,113,.45);',
                warn:    'background:rgba(241,196,15,.18); border:1px solid rgba(241,196,15,.45);',
                bad:     'background:rgba(231,76,60,.18);  border:1px solid rgba(231,76,60,.45);',
                neutral: 'background:rgba(255,255,255,.10); border:1px solid rgba(255,255,255,.18);',
            };
            const st = styles[kind] || styles.neutral;
            return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;white-space:nowrap;${st}">${esc(text)}</span>`;
        };

        const kindFromStatus = (s) => {
            const t = String(s || '').toLowerCase();
            if (t.includes('available') || t.includes('frei') || t.includes('online') || t.includes('ok')) return 'ok';
            if (t.includes('charging') || t.includes('in_use') || t.includes('occupied') || t.includes('belegt')) return 'warn';
            if (t.includes('fault') || t.includes('offline') || t.includes('error') || t.includes('unavailable') || t.includes('störung')) return 'bad';
            return 'neutral';
        };

        const kindFromPort = (s) => {
            const t = String(s || '').toLowerCase();
            if (t.includes('available') || t.includes('frei')) return 'ok';
            if (t.includes('charging') || t.includes('occupied') || t.includes('in_use') || t.includes('belegt')) return 'warn';
            if (t.includes('fault') || t.includes('offline') || t.includes('error') || t.includes('unavailable')) return 'bad';
            return 'neutral';
        };

        const getVal = (relId) => {
            const full = this.namespace + '.' + relId;
            const st = allStates[full];
            return st ? st.val : undefined;
        };

        const updated = new Date().toLocaleString('de-DE');
        let out = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;font-size:14px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
    <div style="font-weight:800;font-size:16px;">⚡ ChargePoint</div>
    <div style="opacity:.75;font-size:12px;">Update: ${esc(updated)}</div>
  </div>
  <div style="border:1px solid rgba(255,255,255,.12);border-radius:14px;overflow:hidden;background:rgba(0,0,0,.18);box-shadow:0 10px 24px rgba(0,0,0,.28);">
`;

        if (!prefixes.length) {
            out += `<div style="padding:12px;">Keine Stationsdaten gefunden.</div></div></div>`;
            return out;
        }

        out += `
    <table style="width:100%;border-collapse:collapse;">
      <tr style="background:rgba(255,255,255,.06)">
        <th style="text-align:left;padding:10px;font-size:12px;letter-spacing:.04em;opacity:.85;">ORT</th>
        <th style="text-align:left;padding:10px;font-size:12px;letter-spacing:.04em;opacity:.85;">STATION</th>
        <th style="text-align:left;padding:10px;font-size:12px;letter-spacing:.04em;opacity:.85;">STATUS</th>
        <th style="text-align:left;padding:10px;font-size:12px;letter-spacing:.04em;opacity:.85;">PORTS</th>
        <th style="text-align:left;padding:10px;font-size:12px;letter-spacing:.04em;opacity:.85;">DISTANZ</th>
        <th style="text-align:left;padding:10px;font-size:12px;letter-spacing:.04em;opacity:.85;">GPS</th>
      </tr>
`;

        for (const p of prefixes) {
            const city = getVal(p + '.city') ?? '';
            const name = getVal(p + '.name') ?? p.split('.').pop();
            const fp = getVal(p + '.freePorts');
            const pc = getVal(p + '.portCount');
            const st = getVal(p + '.statusDerived') ?? '';

            const portsSummary = (fp !== undefined && pc !== undefined)
                ? badge(`${fp}/${pc} frei`, (Number(fp) > 0 ? 'ok' : 'warn'))
                : badge('—', 'neutral');

            const portBadges = [];
            const prefixFull = this.namespace + '.' + p + '.ports.';
            for (const key of Object.keys(allStates)) {
                if (!key.startsWith(prefixFull) || !key.endsWith('.statusV2')) continue;
                const m = key.match(/\.ports\.(\d+)\.statusV2$/);
                if (!m) continue;
                const n = m[1];
                const s2 = getVal(p + `.ports.${n}.statusV2`);
                const s1 = getVal(p + `.ports.${n}.status`);
                const s = (s2 ?? s1);
                if (s === undefined) continue;
                portBadges.push({ n: Number(n), html: badge(`P${n}: ${s}`, kindFromPort(s)) });
            }
            portBadges.sort((a, b) => a.n - b.n);
            const portText = portBadges.length ? portBadges.map(x => x.html).join(' ') : `<span style="opacity:.75;">—</span>`;

            const gpsLat = getVal(p + '.gps.lat');
            const gpsLon = getVal(p + '.gps.lon');
            const gpsOk = (gpsLat !== undefined && gpsLon !== undefined);
            const mapsUrl = gpsOk ? `https://www.google.com/maps?q=${gpsLat},${gpsLon}` : '';
            const gpsText = gpsOk
                ? `<a href="${mapsUrl}" target="_blank" style="color:inherit; text-decoration:underline; opacity:.95;">${esc(gpsLat)}, ${esc(gpsLon)}</a>`
                : `<span style="opacity:.75;">—</span>`;

            const dKm = getVal(p + '.distance.km');
            const distText = (dKm !== undefined && dKm !== null && dKm !== '')
                ? badge(`${dKm} km`, 'neutral')
                : `<span style="opacity:.75;">—</span>`;

            out += `
      <tr style="border-top:1px solid rgba(255,255,255,.08)">
        <td style="padding:10px;vertical-align:top;">${esc(city)}</td>
        <td style="padding:10px;vertical-align:top;font-weight:700;">${esc(name)}</td>
        <td style="padding:10px;vertical-align:top;">${badge(st || '—', kindFromStatus(st))}</td>
        <td style="padding:10px;vertical-align:top;">${portsSummary}<div style="margin-top:6px;line-height:1.8;">${portText}</div></td>
        <td style="padding:10px;vertical-align:top;">${distText}</td>
        <td style="padding:10px;vertical-align:top;">${gpsText}</td>
      </tr>
`;
        }

        out += `
    </table>
  </div>
</div>`;
        return out;
    }

async onReady() {
        this.log.info('Adapter CPT gestartet');

        // Refresh config-derived car settings (do not rely on constructor-time cache)
        this.carLatStateId = (this.config && this.config.carLatStateId) ? String(this.config.carLatStateId).trim() : '';
        this.carLonStateId = (this.config && this.config.carLonStateId) ? String(this.config.carLonStateId).trim() : '';
        this.carSocStateId = (this.config && this.config.carSocStateId) ? String(this.config.carSocStateId).trim() : '';

        this.carLatStatic = (this.config && this.config.carLat !== undefined && this.config.carLat !== null && this.config.carLat !== '') ? Number(this.config.carLat) : null;
        this.carLonStatic = (this.config && this.config.carLon !== undefined && this.config.carLon !== null && this.config.carLon !== '') ? Number(this.config.carLon) : null;

        this.notifySocBelow = (this.config && this.config.notifySocBelow !== undefined && this.config.notifySocBelow !== null && this.config.notifySocBelow !== '') ? Number(this.config.notifySocBelow) : 30;
        this.notifyMaxDistanceM = (this.config && this.config.notifyMaxDistanceM !== undefined && this.config.notifyMaxDistanceM !== null && this.config.notifyMaxDistanceM !== '') ? Number(this.config.notifyMaxDistanceM) : 500;
        this.notifyCooldownMin = (this.config && this.config.notifyCooldownMin !== undefined && this.config.notifyCooldownMin !== null && this.config.notifyCooldownMin !== '') ? Number(this.config.notifyCooldownMin) : 15;

        this.log.debug(`Config (car): latId='${this.carLatStateId}' lonId='${this.carLonStateId}' socId='${this.carSocStateId}' latStatic=${this.carLatStatic} lonStatic=${this.carLonStatic} socBelow=${this.notifySocBelow} maxDistM=${this.notifyMaxDistanceM} cooldownMin=${this.notifyCooldownMin}`);

        await this.ensureToolsObjects();
        await this.ensureCarObjects();
        await this.ensureNearestType2Objects();

        // subscribe to foreign car position states (optional)
        if (this.carLatStateId) this.subscribeForeignStates(this.carLatStateId);
        if (this.carLonStateId) this.subscribeForeignStates(this.carLonStateId);
        if (this.carSocStateId) this.subscribeForeignStates(this.carSocStateId);

        // initialize car position (static or from foreign)
        await this.initCarPosition();
        await this.initCarSoc();
        this.scheduleNearestType2Update('initial');

        this.subscribeStates('tools.export');
        this.subscribeStates('tools.testNotify');
        this.subscribeStates('tools.testNotifyAll');
        this.subscribeStates('stations.*.*.notifyOnAvailable');
        this.subscribeStates('stations.*.*.testNotify');

        const intervalMin = Number(this.config.interval) || 5;

        const stations = (Array.isArray(this.config.stations) ? this.config.stations : [])
            .filter((s) => s && typeof s === 'object')
            .map((s, idx) => {
                const deviceId1 = s.deviceId1 ?? s.stationId ?? s.deviceId ?? s.id;
                const deviceId2 = s.deviceId2 ?? null;
                const name = s.name || `station_${deviceId1 || idx + 1}`;
                const enabled = s.enabled !== false;
                return {
                    name,
                    enabled,
                    notifyOnAvailable: s.notifyOnAvailable === true,
                    deviceId1: deviceId1 ? Number(deviceId1) : null,
                    deviceId2: deviceId2 ? Number(deviceId2) : null,
                };
            })
            .filter((s) => !!s.deviceId1);

        if (!stations.length) {
            this.log.warn('Keine gültigen Stationen konfiguriert');
            return;
        }

        // create tree based on current city names
        for (const st of stations) {
            const data1 = await this.safeFetch(st.deviceId1);
            const data2 = st.deviceId2 ? await this.safeFetch(st.deviceId2) : null;
            const city = this.pickCity(data1, data2);
            const cityKey = this.makeSafeName(city) || 'unbekannt';
            const stationKey = this.getStationKey(st);
            const stationPrefix = `stations.${cityKey}.${stationKey}`;
            this.stationPrefixByName[st.name] = stationPrefix;
            await this.ensureCityChannel(`stations.${cityKey}`, city);
            await this.ensureStationObjects(stationPrefix, st, city);
        }

        await this.updateAllStations(stations);

        // initial VIS HTML write
        this.scheduleVisHtmlUpdate('initial');

        this.pollInterval = setInterval(() => {
            this.updateAllStations(stations).catch((e) => this.log.error(`Polling-Fehler: ${e?.message || e}`));
        }, intervalMin * 60 * 1000);

        this.log.info(`Polling-Intervall: ${intervalMin} Minuten, Stationen: ${stations.length}`);
    }

    async onStateChange(id, state) {
        if (!state) return;

        // foreign car position updates (usually ack=true)
        if (id === this.carLatStateId || id === this.carLonStateId) {
            const latSt = id === this.carLatStateId ? state : (this.carLatStateId ? await this.getForeignStateAsync(this.carLatStateId).catch(() => null) : null);
            const lonSt = id === this.carLonStateId ? state : (this.carLonStateId ? await this.getForeignStateAsync(this.carLonStateId).catch(() => null) : null);
            const lat = latSt && latSt.val !== undefined ? latSt.val : undefined;
            const lon = lonSt && lonSt.val !== undefined ? lonSt.val : undefined;
            if (lat !== undefined && lon !== undefined) {
                await this.updateCarPosition(lat, lon, `${this.carLatStateId} | ${this.carLonStateId}`);
            }
            return;
        }

        // foreign car SoC updates (usually ack=true)
        if (id === this.carSocStateId) {
            await this.updateCarSoc(state.val, this.carSocStateId);
            return;
        }

        if (state.ack) return;

        if (id === `${this.namespace}.tools.export` && state.val === true) {
            await this.doExportStations();
            await this.setStateAsync('tools.export', { val: false, ack: true });
            return;
        }

        if (id === `${this.namespace}.tools.testNotify` && state.val === true) {
            const now = new Date().toISOString();
            const res = await this.sendMessageToChannels('CPT Test: Kommunikation OK ✅');
            await this.setStateAsync('tools.lastTest', { val: now, ack: true });
            await this.setStateAsync('tools.lastTestResult', { val: `ok=${res.ok}, failed=${res.failed}`, ack: true });
            await this.setStateAsync('tools.testNotify', { val: false, ack: true });
            return;
        }

        if (id === `${this.namespace}.tools.testNotifyAll` && state.val === true) {
            try {
                const notifStates = await this.getStatesAsync(this.namespace + '.stations.*.*.notifyOnAvailable');
                const prefixes = Object.keys(notifStates || {})
                    .filter((k) => notifStates[k]?.val === true)
                    .map((k) => k.replace(this.namespace + '.', '').replace(/\.notifyOnAvailable$/, ''))
                    .sort();

                for (const p of prefixes) {
                    await this.sendTestNotifyForPrefix(p);
                }
                this.log.info(`TEST Notify ALL: ${prefixes.length} Station(en) ausgelöst`);
            } catch (e) {
                this.log.warn(`TEST Notify ALL fehlgeschlagen: ${e.message}`);
            } finally {
                await this.setStateAsync('tools.testNotifyAll', { val: false, ack: true });
            }
            return;
        }

        const mTest = id.match(new RegExp('^' + this.namespace.replace(/\./g, '\\.') + '\\.stations\\.(.+?)\\.(.+?)\\.testNotify$'));
        if (mTest && state.val === true) {
            const stationPrefixRel = `stations.${mTest[1]}.${mTest[2]}`;
            try {
                await this.sendTestNotifyForPrefix(stationPrefixRel);
            } catch (e) {
                this.log.warn(`TEST Notify fehlgeschlagen für ${stationPrefixRel}: ${e.message}`);
            } finally {
                await this.setStateAsync(`${stationPrefixRel}.testNotify`, { val: false, ack: true });
            }
        }
    }

    async onMessage(obj) {
        if (!obj) return;

        // dropdown for Abos -> station
        if (obj.command === 'getStations') {
            try {
                // IMPORTANT: jsonConfig "selectSendTo" expects the callback payload to be an ARRAY
                // of {label, value}. If we wrap it into {options:[...]}, Admin shows "instance offline".

                const opts = [{ value: '__ALL__', label: 'Alle Stationen' }];

                // Prefer configured & enabled stations (works before first poll)
                const configured = Array.isArray(this.config.stations) ? this.config.stations : [];
                for (const s of configured) {
                    if (!s || !isTrue(s.enabled)) continue;
                    const n = s.name ? String(s.name).trim() : '';
                    if (!n) continue;
                    const val = `name:${n}`;
                    if (!opts.some((o) => o.value === val)) opts.push({ value: val, label: n });
                }

                // Also include already created station objects (for stable selection by prefix)
                const list = await this.getStatesAsync(this.namespace + '.stations.*.*.name');
                for (const [id, st] of Object.entries(list || {})) {
                    const rel = id.replace(this.namespace + '.', '').replace(/\.name$/, '');
                    const parts = rel.split('.');
                    const city = parts.length >= 3 ? parts[1] : '';
                    const stationName = st?.val ? String(st.val) : parts[2];
                    // Filter to enabled stations if we can match by name
                    if (configured.length) {
                        const match = configured.find((x) => x && isTrue(x.enabled) && String(x.name || '').trim() === stationName);
                        if (!match) continue;
                    }
                    const label = city ? `${city} / ${stationName}` : stationName;
                    if (!opts.some((o) => o.value === rel)) opts.push({ value: rel, label });
                }

                opts.sort((a, b) => a.label.localeCompare(b.label, 'de'));
                obj.callback && this.sendTo(obj.from, obj.command, opts, obj.callback);
            } catch {
                obj.callback && this.sendTo(obj.from, obj.command, [], obj.callback);
            }
            return;
        }

        // dropdown for Abos -> recipient labels
        if (obj.command === 'getRecipients') {
            // IMPORTANT: selectSendTo expects an ARRAY of {label,value} (not {options: ...})
            // Use ALL configured channels (not only enabled), so the dropdown is never empty.
            const channelsRaw = this.config.channels;
            let channels = [];
            if (Array.isArray(channelsRaw)) channels = channelsRaw;
            else if (channelsRaw && typeof channelsRaw === 'object') channels = Object.values(channelsRaw);
            const labels = new Set();
            for (const ch of channels) {
                if (!ch) continue;
                const lbl = String(ch.label || ch.name || ch.instance || '').trim();
                if (lbl) labels.add(lbl);
            }
            const opts = Array.from(labels)
                .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
                .map((l) => ({ value: l, label: l }));
            obj.callback && this.sendTo(obj.from, obj.command, opts, obj.callback);
            return;
        }

        if (obj.command === 'testChannel') {
            const instance = (obj.message?.instance || '').toString().trim();
            const user = (obj.message?.user || '').toString().trim();
            const label = (obj.message?.label || '').toString().trim();

            if (!instance) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: 'Kein Adapter-Instanz gesetzt' }, obj.callback);
                return;
            }

            try {
                const isTelegram = instance.startsWith('telegram.');
                const isWhatsAppCmb = instance.startsWith('whatsapp-cmb.');
                const isOpenWa = instance.startsWith('open-wa.');
                const isPushover = instance.startsWith('pushover.');

                if (isOpenWa && !user) {
                    obj.callback && this.sendTo(obj.from, obj.command, { error: 'Für open-wa muss im Feld Empfänger eine Telefonnummer stehen (z.B. +4917...)' }, obj.callback);
                    return;
                }

                let payload;
                if (isTelegram) {
                    payload = { text: 'CPT Test: Kommunikation OK ✅', ...(user ? { user } : {}) };
                } else if (isWhatsAppCmb) {
                    payload = {
                        phone: user || undefined,
                        number: user || undefined,
                        to: user || undefined,
                        text: 'CPT Test: Kommunikation OK ✅',
                        message: 'CPT Test: Kommunikation OK ✅',
                        title: 'ChargePoint',
                        channelLabel: label || undefined,
                    };
                } else if (isPushover) {
                    payload = { message: 'CPT Test: Kommunikation OK ✅', sound: '' };
                } else if (isOpenWa) {
                    payload = { to: user, text: 'CPT Test: Kommunikation OK ✅' };
                } else {
                    payload = { text: 'CPT Test: Kommunikation OK ✅' };
                }
                Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

                this.sendTo(instance, 'send', payload);
                obj.callback && this.sendTo(obj.from, obj.command, { data: { result: `Test an ${instance} gesendet${user ? ' (' + user + ')' : ''}` } }, obj.callback);
            } catch (e) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
            }
            return;
        }

        if (obj.command === 'testStation') {
            const name = (obj.message?.name || '').toString().trim();
            if (!name) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: 'Kein Stations-Name gesetzt' }, obj.callback);
                return;
            }
            try {
                let stationPrefixRel = this.stationPrefixByName[name];
                if (!stationPrefixRel) {
                    const nameStates = await this.getStatesAsync(this.namespace + '.stations.*.*.name');
                    for (const [id, st] of Object.entries(nameStates || {})) {
                        if (st?.val && String(st.val) === name) {
                            stationPrefixRel = id.replace(this.namespace + '.', '').replace(/\.name$/, '');
                            break;
                        }
                    }
                }
                if (!stationPrefixRel) throw new Error('Station nicht gefunden (noch keine Daten vom Polling?)');

                await this.sendTestNotifyForPrefix(stationPrefixRel);
                obj.callback && this.sendTo(obj.from, obj.command, { data: { result: `Test für ${name} gesendet` } }, obj.callback);
            } catch (e) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
            }
        }
    }

    async doExportStations() {
        const stations = (Array.isArray(this.config.stations) ? this.config.stations : [])
            .filter((s) => s && typeof s === 'object')
            .map((s, idx) => ({
                enabled: s.enabled !== false,
                notifyOnAvailable: s.notifyOnAvailable === true,
                name: s.name || `station_${s.deviceId1 ?? s.stationId ?? s.deviceId ?? idx + 1}`,
                deviceId1: Number(s.deviceId1 ?? s.stationId ?? s.deviceId ?? s.id),
                deviceId2: s.deviceId2 ? Number(s.deviceId2) : null,
            }))
            .filter((s) => !!s.deviceId1);

        const payload = {
            exportedAt: new Date().toISOString(),
            adapter: 'cpt',
            version: this.version,
            interval: Number(this.config.interval) || 5,
            channels: Array.isArray(this.config.channels) ? this.config.channels : this.config.channels || [],
            subscriptions: this.getSubscriptions(),
            stations,
        };

        const jsonStr = JSON.stringify(payload, null, 2);

        await this.setStateAsync('tools.exportJson', { val: jsonStr, ack: true });

        const filename = 'stations_export.json';
        try {
            await this.writeFileAsync(this.namespace, filename, jsonStr);
            await this.setStateAsync('tools.exportFile', { val: filename, ack: true });
        } catch (e) {
            this.log.warn(`Konnte Export-Datei nicht schreiben: ${e.message}`);
            await this.setStateAsync('tools.exportFile', { val: '', ack: true });
        }

        await this.setStateAsync('tools.lastExport', { val: new Date().toISOString(), ack: true });
        this.log.info(`Export erstellt: ${stations.length} Station(en)`);
    }

    onUnload(callback) {
        try {
            if (this.pollInterval) clearInterval(this.pollInterval);
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new CptAdapter(options);
} else {
    new CptAdapter();
}
