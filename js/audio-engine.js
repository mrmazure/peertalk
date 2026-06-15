class AudioEngine {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.localStream = null;
        this.peers = {}; // Map of peerId -> { call, conn, stream }
        this.analysers = {}; // Map of peerId (or 'local') -> AnalyserNode
        this.currentDeviceId = 'default';
        this._lastStats = {}; // peerId -> last RTP counters, for loss % over the interval
    }

    async initCHECK() {
        if (this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }
    }

    async getLocalStream() {
        const constraints = {
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 1
            },
            video: false
        };

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

            const track = this.localStream.getAudioTracks()[0];
            if (track && track.getSettings) {
                this.currentDeviceId = track.getSettings().deviceId;
            }
            return this.localStream;
        } catch (e) {
            console.error('Error accessing microphone:', e);
            // Fallback
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            return this.localStream;
        }
    }

    setupLocalAnalyser() {
        if (!this.localStream) return;

        // Clean up old local analyser if exists? (Not strictly necessary if overwriting keys, but good practice)
        // For simplicity, we just overwrite.

        const source = this.ctx.createMediaStreamSource(this.localStream);

        // Even for Mono, we use a splitter to maintain the [0] and [1] API for consistency
        const splitter = this.ctx.createChannelSplitter(2);
        source.connect(splitter);

        const analyserL = this.ctx.createAnalyser();
        analyserL.fftSize = 256;
        const analyserR = this.ctx.createAnalyser();
        analyserR.fftSize = 256;

        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);

        this.analysers['local'] = { left: analyserL, right: analyserR };
    }

    setupRemoteAudio(peerId, stream) {
        const audio = new Audio();
        audio.srcObject = stream;
        audio.id = `audio-${peerId}`;
        audio.autoplay = true;
        audio.style.display = 'none';
        document.body.appendChild(audio);

        // VU Meter Graph
        const source = this.ctx.createMediaStreamSource(stream);
        const splitter = this.ctx.createChannelSplitter(2);

        const analyserL = this.ctx.createAnalyser();
        analyserL.fftSize = 256;
        const analyserR = this.ctx.createAnalyser();
        analyserR.fftSize = 256;

        source.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);

        this.peers[peerId] = { stream, audio };
        this.analysers[peerId] = { left: analyserL, right: analyserR };
    }

    getAudioLevel(id, channel = 0) {
        // channel: 0 = Left, 1 = Right
        const objs = this.analysers[id];
        if (!objs) return 0;

        const analyser = channel === 1 ? objs.right : objs.left;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        return sum / dataArray.length; // 0-255
    }

    // Time-domain RMS + instantaneous peak, both in dBFS (floor at -60 dB).
    // Mono signal -> we read the left analyser. No buffering / no added latency.
    getAudioStats(id) {
        const FLOOR_DB = -60;
        const objs = this.analysers[id];
        if (!objs || !objs.left) return { rms: FLOOR_DB, peak: FLOOR_DB };

        const analyser = objs.left;
        const len = analyser.fftSize;

        let data;
        if (analyser.getFloatTimeDomainData) {
            data = new Float32Array(len);
            analyser.getFloatTimeDomainData(data);
        } else {
            // Fallback: byte time domain (0-255, 128 = silence) converted to [-1, 1]
            const bytes = new Uint8Array(len);
            analyser.getByteTimeDomainData(bytes);
            data = new Float32Array(len);
            for (let i = 0; i < len; i++) data[i] = (bytes[i] - 128) / 128;
        }

        let sumSquares = 0;
        let peak = 0;
        for (let i = 0; i < len; i++) {
            const s = data[i];
            sumSquares += s * s;
            const a = Math.abs(s);
            if (a > peak) peak = a;
        }

        const rms = Math.sqrt(sumSquares / len);
        const toDb = (lin) => (lin > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(lin)) : FLOOR_DB);

        return { rms: toDb(rms), peak: toDb(peak) };
    }

    mutePeer(peerId, mute) {
        const peerData = this.peers[peerId];
        if (peerData && peerData.audio) {
            peerData.audio.muted = mute;
        }
    }

    // Per-peer playback volume (0..1). Keeps setSinkId intact, adds no latency.
    // Note: audio.muted (mute button) always overrides volume.
    setPeerVolume(peerId, volume) {
        const peerData = this.peers[peerId];
        if (peerData && peerData.audio) {
            const v = Math.max(0, Math.min(1, Number(volume)));
            peerData.audio.volume = isNaN(v) ? 1 : v;
        }
    }

    // Read live link health from the RTCPeerConnection for one peer.
    // Loss % is computed over the interval between two readings (delta), RTT in ms.
    async getConnectionQuality(peerConnection, peerId) {
        const result = { quality: 'unknown', lossPct: 0, rttMs: null, jitterMs: 0 };
        if (!peerConnection || !peerConnection.getStats) return result;

        let stats;
        try {
            stats = await peerConnection.getStats();
        } catch (e) {
            return result;
        }

        let inbound = null;
        let rtt = null;        // from the nominated/selected pair
        let fallbackRtt = null; // any succeeded pair, in case nominated isn't flagged

        stats.forEach(report => {
            if (report.type === 'inbound-rtp' &&
                (report.kind === 'audio' || report.mediaType === 'audio')) {
                inbound = report;
            }
            if (report.type === 'candidate-pair' && report.state === 'succeeded' &&
                typeof report.currentRoundTripTime === 'number') {
                if (report.nominated || report.selected) rtt = report.currentRoundTripTime;
                else if (fallbackRtt == null) fallbackRtt = report.currentRoundTripTime;
            }
        });

        const effectiveRtt = rtt != null ? rtt : fallbackRtt;
        if (effectiveRtt != null) result.rttMs = effectiveRtt * 1000;

        if (inbound) {
            if (typeof inbound.jitter === 'number') result.jitterMs = inbound.jitter * 1000;

            const prev = this._lastStats[peerId];
            const curr = {
                packetsReceived: inbound.packetsReceived || 0,
                packetsLost: inbound.packetsLost || 0
            };

            if (prev) {
                const dReceived = curr.packetsReceived - prev.packetsReceived;
                const dLost = curr.packetsLost - prev.packetsLost;
                const total = dReceived + dLost;
                result.lossPct = total > 0 ? Math.max(0, (dLost / total) * 100) : 0;
            } else {
                result.lossPct = 0; // first reading: no delta available yet
            }

            this._lastStats[peerId] = curr;
        }

        // Classify
        if (!inbound && effectiveRtt == null) {
            result.quality = 'unknown';
        } else {
            const r = result.rttMs != null ? result.rttMs : 0;
            const loss = result.lossPct;
            if (loss < 2 && r < 150) result.quality = 'good';
            else if (loss < 5 && r < 300) result.quality = 'medium';
            else result.quality = 'bad';
        }

        return result;
    }

    // Release all audio resources tied to a peer (prevents leaks on disconnect)
    cleanupPeer(peerId) {
        // 1. Stop + detach + remove the <audio> element
        const peerData = this.peers[peerId];
        if (peerData && peerData.audio) {
            try {
                peerData.audio.pause();
                peerData.audio.srcObject = null;
            } catch (e) { /* ignore */ }
            if (peerData.audio.parentNode) {
                peerData.audio.parentNode.removeChild(peerData.audio);
            }
        }

        // 2. Disconnect the analyser nodes
        const analyserObj = this.analysers[peerId];
        if (analyserObj) {
            try {
                if (analyserObj.left) analyserObj.left.disconnect();
                if (analyserObj.right) analyserObj.right.disconnect();
            } catch (e) { /* ignore */ }
        }

        // 3. Drop references
        delete this.peers[peerId];
        delete this.analysers[peerId];
        delete this._lastStats[peerId];
    }

    muteLocal(mute) {
        if (this.localStream) {
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = !mute;
            });
        }
    }

    async getDevices() {
        return await navigator.mediaDevices.enumerateDevices();
    }

    async setSinkId(peerId, deviceId) {
        const peerData = this.peers[peerId];
        if (peerData && peerData.audio && peerData.audio.setSinkId) {
            try {
                await peerData.audio.setSinkId(deviceId);
            } catch (e) {
                console.error('Error setting sink ID', e);
            }
        }
    }

    async changeInputDevice(deviceId) {
        this.currentDeviceId = deviceId;

        // Stop old tracks
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }

        const constraints = {
            audio: {
                deviceId: { exact: deviceId },
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 1 // Strict Mono
            },
            video: false
        };

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            console.warn("Constraint failed, trying fallback", e);
            // Fallback: relax channel count constraint
            const fallbackConstraints = {
                audio: {
                    deviceId: { exact: deviceId }
                }
            };
            this.localStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
        }

        this.setupLocalAnalyser();
        return this.localStream;
    }
}
