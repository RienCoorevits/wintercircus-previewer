class BridgeAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channelCount = 0;
    this.capacityFrames = 0;
    this.prebufferFrames = 0;
    this.buffers = [];
    this.readIndex = 0;
    this.writeIndex = 0;
    this.framesAvailable = 0;
    this.started = false;
    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }

  handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "configure") {
      this.configure(message.channelCount, message.prebufferSeconds);
      return;
    }

    if (message.type === "reset") {
      this.reset();
      return;
    }

    if (message.type === "enqueue") {
      this.enqueue(message.channels, message.frameCount);
    }
  }

  configure(nextChannelCount, nextPrebufferSeconds = 0.2) {
    const channelCount = Math.max(1, Number(nextChannelCount) || 1);
    const prebufferFrames = Math.max(128, Math.round((Number(nextPrebufferSeconds) || 0.2) * sampleRate));
    const capacityFrames = Math.max(prebufferFrames * 8, Math.round(sampleRate * 2.5));

    if (channelCount !== this.channelCount || capacityFrames !== this.capacityFrames) {
      this.channelCount = channelCount;
      this.capacityFrames = capacityFrames;
      this.buffers = Array.from({ length: channelCount }, () => new Float32Array(capacityFrames));
    }

    this.prebufferFrames = prebufferFrames;
    this.reset();
  }

  reset() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.framesAvailable = 0;
    this.started = false;
  }

  enqueue(channelBuffers, frameCount) {
    if (!Array.isArray(channelBuffers) || this.channelCount === 0 || frameCount <= 0) {
      return;
    }

    const incomingChannels = channelBuffers
      .slice(0, this.channelCount)
      .map((channelBuffer) => new Float32Array(channelBuffer));

    if (incomingChannels.length === 0) {
      return;
    }

    if (frameCount >= this.capacityFrames) {
      const startFrame = frameCount - this.capacityFrames;
      for (let channelIndex = 0; channelIndex < incomingChannels.length; channelIndex += 1) {
        incomingChannels[channelIndex] = incomingChannels[channelIndex].subarray(startFrame);
      }
      frameCount = this.capacityFrames;
      this.reset();
    }

    const overflowFrames = Math.max(0, this.framesAvailable + frameCount - this.capacityFrames);
    if (overflowFrames > 0) {
      this.readIndex = (this.readIndex + overflowFrames) % this.capacityFrames;
      this.framesAvailable -= overflowFrames;
    }

    for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
      const source = incomingChannels[channelIndex] || incomingChannels[0];
      const destination = this.buffers[channelIndex];
      const firstChunkLength = Math.min(frameCount, this.capacityFrames - this.writeIndex);
      destination.set(source.subarray(0, firstChunkLength), this.writeIndex);
      if (firstChunkLength < frameCount) {
        destination.set(source.subarray(firstChunkLength, frameCount), 0);
      }
    }

    this.writeIndex = (this.writeIndex + frameCount) % this.capacityFrames;
    this.framesAvailable = Math.min(this.framesAvailable + frameCount, this.capacityFrames);
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }

    const frameCount = output[0].length;
    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      output[channelIndex].fill(0);
    }

    if (this.channelCount === 0) {
      return true;
    }

    if (!this.started) {
      if (this.framesAvailable < this.prebufferFrames) {
        return true;
      }
      this.started = true;
    }

    const framesToCopy = Math.min(frameCount, this.framesAvailable);
    if (framesToCopy > 0) {
      for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
        const source = this.buffers[Math.min(channelIndex, this.channelCount - 1)];
        const destination = output[channelIndex];
        const firstChunkLength = Math.min(framesToCopy, this.capacityFrames - this.readIndex);
        destination.set(source.subarray(this.readIndex, this.readIndex + firstChunkLength), 0);
        if (firstChunkLength < framesToCopy) {
          destination.set(source.subarray(0, framesToCopy - firstChunkLength), firstChunkLength);
        }
      }

      this.readIndex = (this.readIndex + framesToCopy) % this.capacityFrames;
      this.framesAvailable -= framesToCopy;
    }

    if (framesToCopy < frameCount) {
      this.started = false;
    }

    return true;
  }
}

registerProcessor("bridge-audio-processor", BridgeAudioProcessor);
