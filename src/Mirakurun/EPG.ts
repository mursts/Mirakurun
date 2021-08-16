/*
   Copyright 2016 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
import { getProgramItemId } from "./Program";
import { sleep } from "./common";
import * as db from "./db";
import _ from "./_";
import * as aribts from "aribts";
const TsChar = aribts.TsChar;

const STREAM_CONTENT = {
    1: "mpeg2",
    5: "h.264",
    9: "h.265"
};

const COMPONENT_TYPE = {
    0x01: "480i",
    0x02: "480i",
    0x03: "480i",
    0x04: "480i",
    0x83: "4320p",
    0x91: "2160p",
    0x92: "2160p",
    0x93: "2160p",
    0x94: "2160p",
    0xA1: "480p",
    0xA2: "480p",
    0xA3: "480p",
    0xA4: "480p",
    0xB1: "1080i",
    0xB2: "1080i",
    0xB3: "1080i",
    0xB4: "1080i",
    0xC1: "720p",
    0xC2: "720p",
    0xC3: "720p",
    0xC4: "720p",
    0xD1: "240p",
    0xD2: "240p",
    0xD3: "240p",
    0xD4: "240p",
    0xE1: "1080p",
    0xE2: "1080p",
    0xE3: "1080p",
    0xE4: "1080p",
    0xF1: "180p",
    0xF2: "180p",
    0xF3: "180p",
    0xF4: "180p"
};

const SAMPLING_RATE = {
    0: -1,
    1: 16000,
    2: 22050,
    3: 24000,
    4: -1,
    5: 32000,
    6: 44100,
    7: 48000
};

const UNKNOWN_START_TIME = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
const UNKNOWN_DURATION = Buffer.from([0xFF, 0xFF, 0xFF]);

const ISO_639_LANG_CODE = {
    jpn: Buffer.from("6A706E", "hex"),
    eng: Buffer.from("656E67", "hex"),
    deu: Buffer.from("646575", "hex"),
    fra: Buffer.from("667261", "hex"),
    ita: Buffer.from("697461", "hex"),
    rus: Buffer.from("727573", "hex"),
    zho: Buffer.from("7A686F", "hex"),
    kor: Buffer.from("6B6F72", "hex"),
    spa: Buffer.from("737061", "hex"),
    etc: Buffer.from("657463", "hex")
};

interface VersionDict<T = number> {
    [tableId: number]: T;
}

interface EventState {
    version: VersionDict;
    program: db.Program;

    short: {
        version: VersionDict; // basic
    };
    extended: {
        version: VersionDict; // extended
        _descs?: {
            item_description_length: number;
            item_description_char: Buffer;
            item_length: number;
            item_char: Buffer;
        }[][];
        _done?: boolean;
    };
    component: {
        version: VersionDict; // basic
    };
    content: {
        version: VersionDict; // basic
    };
    audio: {
        version: VersionDict<VersionDict>; // basic
        _audios: { [componentTag: number]: db.ProgramAudio };
    };
    series: {
        version: VersionDict; // basic
    };
    group: {
        version: VersionDict<VersionDict>; // basic
        _groups: db.ProgramRelatedItem[][];
    };
}

// forked from rndomhack/node-aribts/blob/1e7ef94bba3d6ac26aec764bf24dde2c2852bfcb/lib/epg.js
export default class EPG {

    private _epg: { [networkId: number]: { [serviceId: number]: { [eventId: number]: EventState } } } = {};
    private _queue: any[] = [];
    private _running = false;
    private _end = false;

    write(eit: any) {

        if (!this._epg) {
            return;
        }

        this._queue.push(eit);

        if (!this._running) {
            this._run();
        }
    }

    end() {

        this._end = true;

        if (this._epg && this._queue.length === 0 && this._running === false) {
            delete this._epg;
        }
    }

    private async _run() {

        if (!this._epg || this._running || this._queue.length === 0) {
            return;
        }
        this._running = true;

        const eit = this._queue.shift();

        const networkId = eit.original_network_id;

        if (!this._epg[networkId]) {
            this._epg[networkId] = {};
        }

        if (!this._epg[networkId][eit.service_id]) {
            this._epg[networkId][eit.service_id] = {};
        }

        const service = this._epg[networkId][eit.service_id];

        for (const e of eit.events) {
            let state: EventState;

            if (!service[e.event_id]) {
                const id = getProgramItemId(networkId, eit.service_id, e.event_id);
                let programItem = _.program.get(id);
                if (!programItem) {
                    if (UNKNOWN_START_TIME.compare(e.start_time) === 0) {
                        continue;
                    }
                    programItem = {
                        id,
                        eventId: e.event_id,
                        serviceId: eit.service_id,
                        networkId: networkId,
                        startAt: getTime(e.start_time),
                        duration: UNKNOWN_DURATION.compare(e.duration) === 0 ? 1 : getTimeFromBCD24(e.duration),
                        isFree: e.free_CA_mode === 0,
                        _pf: eit.table_id === 0x4E || eit.table_id === 0x4F || undefined
                    };
                    _.program.add(programItem);
                }

                state = {
                    version: {},
                    program: programItem,

                    short: {
                        version: {}
                    },
                    extended: {
                        version: {}
                    },
                    component: {
                        version: {}
                    },
                    content: {
                        version: {}
                    },
                    audio: {
                        version: {},
                        _audios: {}
                    },
                    series: {
                        version: {}
                    },
                    group: {
                        version: {},
                        _groups: []
                    }
                };

                service[e.event_id] = state;
            } else {
                state = service[e.event_id];

                if (isOutOfDate(eit, state.version)) {
                    state.version[eit.table_id] = eit.version_number;

                    if (UNKNOWN_START_TIME.compare(e.start_time) !== 0) {
                        _.program.set(state.program.id, {
                            startAt: getTime(e.start_time),
                            duration: UNKNOWN_DURATION.compare(e.duration) === 0 ? 1 : getTimeFromBCD24(e.duration),
                            isFree: e.free_CA_mode === 0,
                            _pf: eit.table_id === 0x4E || eit.table_id === 0x4F || undefined
                        });
                    }
                }
            }

            for (const d of e.descriptors) {
                switch (d.descriptor_tag) {
                    // short_event
                    case 0x4D:
                        if (!isOutOfDate(eit, state.short.version)) {
                            break;
                        }
                        state.short.version[eit.table_id] = eit.version_number;

                        _.program.set(state.program.id, {
                            name: new TsChar(d.event_name_char).decode(),
                            description: new TsChar(d.text_char).decode()
                        });

                        break;

                    // extended_event
                    case 0x4E:
                        if (isOutOfDate(eit, state.extended.version)) {
                            state.extended.version[eit.table_id] = eit.version_number;
                            state.extended._descs = new Array(d.last_descriptor_number + 1);
                            state.extended._done = false;
                        } else if (state.extended._done) {
                            break;
                        }

                        if (!state.extended._descs[d.descriptor_number]) {
                            state.extended._descs[d.descriptor_number] = d.items;

                            let comp = true;
                            for (const descs of state.extended._descs) {
                                if (typeof descs === "undefined") {
                                    comp = false;
                                    break;
                                }
                            }
                            if (comp === false) {
                                break;
                            }

                            const extended: any = {};

                            let current = "";
                            for (const descs of state.extended._descs) {
                                for (const desc of descs) {
                                    const key = desc.item_description_length === 0
                                                ? current
                                                : new TsChar(desc.item_description_char).decode();
                                    current = key;
                                    extended[key] = extended[key] ?
                                        Buffer.concat([extended[key], desc.item_char]) :
                                        Buffer.from(desc.item_char);
                                }
                            }
                            for (const key of Object.keys(extended)) {
                                extended[key] = new TsChar(extended[key]).decode();
                            }

                            _.program.set(state.program.id, {
                                extended: extended
                            });

                            delete state.extended._descs;
                            state.extended._done = true; // done
                        }

                        break;

                    // component
                    case 0x50:
                        if (!isOutOfDate(eit, state.component.version)) {
                            break;
                        }
                        state.component.version[eit.table_id] = eit.version_number;

                        _.program.set(state.program.id, {
                            video: {
                                type: <db.ProgramVideoType> STREAM_CONTENT[d.stream_content] || null,
                                resolution: <db.ProgramVideoResolution> COMPONENT_TYPE[d.component_type] || null,

                                streamContent: d.stream_content,
                                componentType: d.component_type
                            }
                        });

                        break;

                    // content
                    case 0x54:
                        if (!isOutOfDate(eit, state.content.version)) {
                            break;
                        }
                        state.content.version[eit.table_id] = eit.version_number;

                        _.program.set(state.program.id, {
                            genres: d.contents.map(getGenre)
                        });

                        break;

                    // audio component
                    case 0xC4:
                        if (!isOutOfDateLv2(eit, state.audio.version, d.component_tag)) {
                            break;
                        }
                        state.audio.version[eit.table_id][d.component_tag] = eit.version_number;

                        const langs = [getLangCode(d.ISO_639_language_code)];
                        if (d.ISO_639_language_code_2) {
                            langs.push(getLangCode(d.ISO_639_language_code_2));
                        }

                        state.audio._audios[d.component_tag] = {
                            componentType: d.component_type,
                            componentTag: d.component_tag,
                            isMain: d.main_component_flag === 1,
                            samplingRate: SAMPLING_RATE[d.sampling_rate],
                            langs
                        };

                        _.program.set(state.program.id, {
                            audios: Object.values(state.audio._audios)
                        });

                        break;

                    // series
                    case 0xD5:
                        if (!isOutOfDate(eit, state.series.version)) {
                            break;
                        }
                        state.series.version[eit.table_id] = eit.version_number;

                        _.program.set(state.program.id, {
                            series: {
                                id: d.series_id,
                                repeat: d.repeat_label,
                                pattern: d.program_pattern,
                                expiresAt: d.expire_date_valid_flag === 1 ?
                                    getTime(Buffer.from(d.expire_date.toString(16), "hex")) :
                                    -1,
                                episode: d.episode_number,
                                lastEpisode: d.last_episode_number,
                                name: new TsChar(d.series_name_char).decode()
                            }
                        });

                        break;

                    // event_group
                    case 0xD6:
                        if (!isOutOfDateLv2(eit, state.group.version, d.group_type)) {
                            break;
                        }
                        state.group.version[eit.table_id][d.group_type] = eit.version_number;

                        state.group._groups[d.group_type] = d.group_type < 4 ?
                            d.events.map(getRelatedProgramItem.bind(d)) :
                            d.other_network_events.map(getRelatedProgramItem.bind(d));

                        _.program.set(state.program.id, {
                            relatedItems: state.group._groups.flat()
                        });

                        break;
                }// <- switch
            }// <- for

            await sleep(10);
        }// <- for

        this._running = false;

        if (this._end && this._queue.length === 0) {
            this.end();
        }

        if (this._queue.length > 0) {
            this._run();
        }
    }
}

function isOutOfDate(eit: any, versionDict: VersionDict): boolean {

    if (
        (versionDict[0x4E] !== undefined || versionDict[0x4F] !== undefined) &&
        (eit.table_id !== 0x4E && eit.table_id !== 0x4F)
    ) {
        return false;
    }

    return versionDict[eit.table_id] !== eit.version_number;
}

function isOutOfDateLv2(eit: any, versionDict: VersionDict<VersionDict>, lv2: number): boolean {

    if (versionDict[eit.table_id] === undefined) {
        versionDict[eit.table_id] = {};
    }
    if (
        (versionDict[0x4E] !== undefined || versionDict[0x4F] !== undefined) &&
        (eit.table_id !== 0x4E && eit.table_id !== 0x4F)
    ) {
        return false;
    }

    return versionDict[eit.table_id][lv2] === eit.version_number;
}

function getTime(buffer: Buffer): number {

    const mjd = (buffer[0] << 8) | buffer[1];
    const h = (buffer[2] >> 4) * 10 + (buffer[2] & 0x0F);
    const i = (buffer[3] >> 4) * 10 + (buffer[3] & 0x0F);
    const s = (buffer[4] >> 4) * 10 + (buffer[4] & 0x0F);

    return ((mjd - 40587) * 86400 + ((h - 9) * 60 * 60) + (i * 60) + s) * 1000;
}

function getTimeFromBCD24(buffer: Buffer): number {

    let time = ((buffer[0] >> 4) * 10 + (buffer[0] & 0x0F)) * 3600;
    time += ((buffer[1] >> 4) * 10 + (buffer[1] & 0x0F)) * 60;
    time += (buffer[2] >> 4) * 10 + (buffer[2] & 0x0F);

    return time * 1000;
}

function getGenre(content: any): db.ProgramGenre {
    return {
        lv1: content.content_nibble_level_1,
        lv2: content.content_nibble_level_2,
        un1: content.user_nibble_1,
        un2: content.user_nibble_2
    };
}

function getLangCode(buffer: Buffer): db.ProgramAudioLanguageCode {
    for (const code in ISO_639_LANG_CODE) {
        if (ISO_639_LANG_CODE[code].compare(buffer) === 0) {
            return code as db.ProgramAudioLanguageCode;
        }
    }
    return "etc";
}

function getRelatedProgramItem(event: any): db.ProgramRelatedItem {
    return {
        type: (
            this.group_type === 1 ? "shared" :
                (this.group_type === 2 || this.group_type === 4) ? "relay" : "movement"
        ),
        networkId: event.original_network_id,
        serviceId: event.service_id,
        eventId: event.event_id
    };
}
