/* Minimal GTFS-RT VehiclePositions decoder - the probe for the harness.
 * Field numbers per the official gtfs-realtime proto (verified against the
 * python-gtfs-realtime-bindings descriptors):
 *   FeedMessage       field 1 = header (skipped), repeated field 2 = FeedEntity
 *   FeedEntity        field 1 = id, field 4 = vehicle (VehiclePosition)
 *   VehiclePosition   field 1 = trip (TripDescriptor), field 2 = position,
 *                     field 3 = current_stop_sequence, field 8 = vehicle (VehicleDescriptor)
 *   TripDescriptor    field 1 = trip_id, field 5 = route_id, field 6 = direction_id
 *   Position          field 1 = latitude (float), field 2 = longitude (float),
 *                     field 3 = bearing (float)
 *   VehicleDescriptor field 1 = id, field 2 = label
 * Wire types: 0 varint, 2 length-delimited, 5 32-bit float. Anything the
 * decoder does not know is skipped by its length or group end, so unknown
 * fields stay harmless.
 */
let DV = null;
const f32 = (at) => DV.getFloat32(at, true);

export function decodeVehiclePositions(buf) {
    DV = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let p = 0;
    const end = buf.length;
    const varint = () => {
        let shift = 0, val = 0n;
        while (true) {
            const b = buf[p++];
            val |= BigInt(b & 0x7f) << BigInt(shift);
            if (!(b & 0x80)) return val;
            shift += 7;
        }
    };
    const skip = (wt) => {
        if (wt === 0) varint();
        else if (wt === 1) p += 8;
        else if (wt === 2) { const n2 = Number(varint()); p += n2; }
        else if (wt === 5) p += 4;
        else if (wt === 3) {           // deprecated start-group: skip to its end
            for (;;) {
                const t2 = varint();
                if (Number(t2 & 7n) === 4) break;
                skip(Number(t2 & 7n));
            }
        }
        else throw new Error("wire type " + wt);
    };
    const text = (n) => new TextDecoder().decode(buf.subarray(p, p + n));

    const out = [];
    while (p < end) {
        const tag = varint();
        const wt = Number(tag & 7n), fn = Number(tag >> 3n);
        if (fn !== 2 || wt !== 2) { skip(wt); continue; }   // header, etc.
        const len = Number(varint());
        const eEnd = p + len;
        let veh = null, id = null;
        while (p < eEnd) {
            const t2 = varint();
            const w2 = Number(t2 & 7n), f2 = Number(t2 >> 3n);
            if (f2 === 1 && w2 === 2) { const n = Number(varint()); id = text(n); p += n; }
            else if (f2 === 4 && w2 === 2) { const n = Number(varint()); veh = decodeVehicle(buf.subarray(p, p + n)); p += n; }
            else skip(w2);
        }
        p = eEnd;
        if (veh) out.push({ id, ...veh });
    }
    return out;
}

function decodeVehicle(buf) {
    let p = 0;
    const end = buf.length;
    const varint = () => {
        let shift = 0, val = 0n;
        while (true) {
            const b = buf[p++];
            val |= BigInt(b & 0x7f) << BigInt(shift);
            if (!(b & 0x80)) return val;
            shift += 7;
        }
    };
    const skip = (wt) => {
        if (wt === 0) varint();
        else if (wt === 1) p += 8;
        else if (wt === 2) { const n2 = Number(varint()); p += n2; }
        else if (wt === 5) p += 4;
        else if (wt === 3) {
            for (;;) {
                const t2 = varint();
                if (Number(t2 & 7n) === 4) break;
                skip(Number(t2 & 7n));
            }
        }
        else throw new Error("wire type " + wt);
    };
    const out = { trip: null, pos: null, seq: null, vehicle: null };
    while (p < end) {
        const tag = varint();
        const wt = Number(tag & 7n), fn = Number(tag >> 3n);
        if (fn === 1 && wt === 2) { const n = Number(varint()); out.trip = decodeTrip(buf.subarray(p, p + n)); p += n; }
        else if (fn === 2 && wt === 2) { const n = Number(varint()); out.pos = decodePos(buf.subarray(p, p + n)); p += n; }
        else if (fn === 3 && wt === 0) out.seq = Number(varint());
        else if (fn === 8 && wt === 2) { const n = Number(varint()); out.vehicle = decodeVehDesc(buf.subarray(p, p + n)); p += n; }
        else skip(wt);
    }
    return out;
}

function decodeTrip(buf) {
    let p = 0;
    const end = buf.length;
    const varint = () => {
        let shift = 0, val = 0n;
        while (true) {
            const b = buf[p++];
            val |= BigInt(b & 0x7f) << BigInt(shift);
            if (!(b & 0x80)) return val;
            shift += 7;
        }
    };
    const skip = (wt) => {
        if (wt === 0) varint();
        else if (wt === 1) p += 8;
        else if (wt === 2) { const n2 = Number(varint()); p += n2; }
        else if (wt === 5) p += 4;
        else if (wt === 3) {
            for (;;) {
                const t2 = varint();
                if (Number(t2 & 7n) === 4) break;
                skip(Number(t2 & 7n));
            }
        }
        else throw new Error("wire type " + wt);
    };
    const out = {};
    while (p < end) {
        const tag = varint();
        const wt = Number(tag & 7n), fn = Number(tag >> 3n);
        if (fn === 1 && wt === 2) { const n = Number(varint()); out.trip_id = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; }
        else if (fn === 5 && wt === 2) { const n = Number(varint()); out.route_id = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; }
        else if (fn === 6 && wt === 0) out.direction_id = Number(varint());
        else skip(wt);
    }
    return out;
}

function decodePos(buf) {
    let p = 0;
    const end = buf.length;
    const varint = () => {
        let shift = 0, val = 0n;
        while (true) {
            const b = buf[p++];
            val |= BigInt(b & 0x7f) << BigInt(shift);
            if (!(b & 0x80)) return val;
            shift += 7;
        }
    };
    const skip = (wt) => {
        if (wt === 0) varint();
        else if (wt === 1) p += 8;
        else if (wt === 2) { const n2 = Number(varint()); p += n2; }
        else if (wt === 5) p += 4;
        else if (wt === 3) {
            for (;;) {
                const t2 = varint();
                if (Number(t2 & 7n) === 4) break;
                skip(Number(t2 & 7n));
            }
        }
        else throw new Error("wire type " + wt);
    };
    const out = {};
    while (p < end) {
        const tag = varint();
        const wt = Number(tag & 7n), fn = Number(tag >> 3n);
        if (fn === 1 && wt === 5) { out.latitude = f32(p); p += 4; }
        else if (fn === 2 && wt === 5) { out.longitude = f32(p); p += 4; }
        else if (fn === 3 && wt === 5) { out.bearing = f32(p); p += 4; }
        else skip(wt);
    }
    return out;
}

function decodeVehDesc(buf) {
    let p = 0;
    const end = buf.length;
    const varint = () => {
        let shift = 0, val = 0n;
        while (true) {
            const b = buf[p++];
            val |= BigInt(b & 0x7f) << BigInt(shift);
            if (!(b & 0x80)) return val;
            shift += 7;
        }
    };
    const skip = (wt) => {
        if (wt === 0) varint();
        else if (wt === 1) p += 8;
        else if (wt === 2) { const n2 = Number(varint()); p += n2; }
        else if (wt === 5) p += 4;
        else if (wt === 3) {
            for (;;) {
                const t2 = varint();
                if (Number(t2 & 7n) === 4) break;
                skip(Number(t2 & 7n));
            }
        }
        else throw new Error("wire type " + wt);
    };
    const out = {};
    while (p < end) {
        const tag = varint();
        const wt = Number(tag & 7n), fn = Number(tag >> 3n);
        if (fn === 1 && wt === 2) { const n = Number(varint()); out.id = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; }
        else if (fn === 2 && wt === 2) { const n = Number(varint()); out.label = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; }
        else skip(wt);
    }
    return out;
}
