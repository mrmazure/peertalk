class AudioEngine {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.localStream = null;
        this.peers = {}; // Map of peerId -> { call, conn, stream }
        this.analysers = {}; // Map of peerId (or 'local') -> AnalyserNode
        this.currentDeviceId = 'default';
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

    mutePeer(peerId, mute) {
        const peerData = this.peers[peerId];
        if (peerData && peerData.audio) {
            peerData.audio.muted = mute;
        }
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
