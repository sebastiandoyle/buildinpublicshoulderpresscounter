(function() {
  const videoEl = document.getElementById('video');
  const canvasEl = document.getElementById('overlay');
  const ctx = canvasEl.getContext('2d');

  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const resetBtn = document.getElementById('reset-btn');

  const repCountEl = document.getElementById('rep-count');
  const avgIntervalEl = document.getElementById('avg-interval');
  const lastIntervalEl = document.getElementById('last-interval');
  const repStateEl = document.getElementById('rep-state');
  const cameraStatusEl = document.getElementById('camera-status');

  /** @type {MediaStream | null} */
  let mediaStream = null;
  /** @type {poseDetection.PoseDetector | null} */
  let detector = null;
  let running = false;
  let rafId = 0;

  let repCount = 0;
  let phase = 'unknown'; // 'below' | 'above' | 'unknown'
  let lastRepTime = 0;
  const intervals = [];

  const SCORE_THRESHOLD = 0.5;
  const ABOVE_MARGIN_RATIO = 0.03; // 3% of frame height
  const BELOW_MARGIN_RATIO = 0.03; // 3% of frame height

  startBtn.addEventListener('click', () => start());
  stopBtn.addEventListener('click', () => stop());
  resetBtn.addEventListener('click', () => reset());

  function setUiRunning(isRunning) {
    startBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
    cameraStatusEl.textContent = isRunning ? 'on' : 'off';
  }

  async function createDetectorWithFallback() {
    // Use MoveNet Lightning (faster, smaller model) with simple config
    try {
      await tf.ready();
      return await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING
      });
    } catch (e) {
      console.error('MoveNet failed', e);
      return null;
    }
  }

  async function start() {
    if (running) return;

    // Track camera start event
    if (typeof va !== 'undefined') {
      va.track('camera_started');
    }

    setUiRunning(true);
    cameraStatusEl.textContent = 'starting…';

    // 1) Start camera
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      videoEl.srcObject = mediaStream;
      await videoEl.play();
      if (!videoEl.videoWidth || !videoEl.videoHeight) {
        await new Promise(resolve => videoEl.addEventListener('loadedmetadata', resolve, { once: true }));
      }
      resizeCanvasToVideo();
      running = true; // camera is running
      cameraStatusEl.textContent = 'on';
    } catch (err) {
      console.error('Camera start failed', err);
      cameraStatusEl.textContent = 'error';
      setUiRunning(false);
      running = false;
      alert('Could not start camera. Please allow camera permission and try again.');
      return;
    }

    // 2) Load pose detector (non-fatal if fails)
    detector = await createDetectorWithFallback();
    if (!detector) {
      repStateEl.textContent = 'model error';
      return; // keep camera on
    }

    // 3) Start detection loop
    detectLoop();
  }

  async function stop() {
    running = false;
    cancelAnimationFrame(rafId);
    if (detector) {
      try { await detector.dispose(); } catch (e) {}
      detector = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    setUiRunning(false);
  }

  function reset() {
    // Track reset event
    if (typeof va !== 'undefined') {
      va.track('workout_reset', { previous_rep_count: repCount });
    }
    
    repCount = 0;
    phase = 'unknown';
    lastRepTime = 0;
    intervals.length = 0;
    updateStats();
  }

  function resizeCanvasToVideo() {
    const cssRect = videoEl.getBoundingClientRect();
    canvasEl.width = Math.max(1, Math.round(cssRect.width * devicePixelRatio));
    canvasEl.height = Math.max(1, Math.round(cssRect.height * devicePixelRatio));
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  window.addEventListener('resize', resizeCanvasToVideo);

  function chooseSide(keypoints) {
    const lShoulder = getKP(keypoints, ['left_shoulder', 'leftShoulder'], 11);
    const rShoulder = getKP(keypoints, ['right_shoulder', 'rightShoulder'], 12);
    const lElbow = getKP(keypoints, ['left_elbow', 'leftElbow'], 13);
    const rElbow = getKP(keypoints, ['right_elbow', 'rightElbow'], 14);

    const leftScore = Math.min((lShoulder?.score ?? 0), (lElbow?.score ?? 0));
    const rightScore = Math.min((rShoulder?.score ?? 0), (rElbow?.score ?? 0));

    if (leftScore >= rightScore) {
      return { shoulder: lShoulder, elbow: lElbow, side: 'left' };
    }
    return { shoulder: rShoulder, elbow: rElbow, side: 'right' };
  }

  function getKP(keypoints, names, fallbackIndex) {
    let found = null;
    for (const kp of keypoints || []) {
      const name = (kp.name || kp.part || '').toString();
      if (names.includes(name)) { found = kp; break; }
    }
    if (!found && keypoints && keypoints[fallbackIndex]) return keypoints[fallbackIndex];
    return found;
  }

  function drawOverlay(shoulder, elbow) {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!shoulder || !elbow) return;

    const vw = videoEl.videoWidth || canvasEl.width;
    const vh = videoEl.videoHeight || canvasEl.height;

    // Convert keypoint positions (video pixels) into CSS pixel coordinates
    const cssRect = videoEl.getBoundingClientRect();
    const scaleX = cssRect.width / vw;
    const scaleY = cssRect.height / vh;

    const sx = shoulder.x * scaleX;
    const sy = shoulder.y * scaleY;
    const ex = elbow.x * scaleX;
    const ey = elbow.y * scaleY;

    ctx.lineWidth = 4;
    ctx.strokeStyle = '#94a3b8';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    ctx.fillStyle = '#10b981';
    drawCircle(sx, sy, 8);

    ctx.fillStyle = '#ef4444';
    drawCircle(ex, ey, 8);
  }

  function drawCircle(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function updateStats() {
    repCountEl.textContent = String(repCount);
    if (intervals.length > 0) {
      const last = intervals[intervals.length - 1] / 1000;
      lastIntervalEl.textContent = last.toFixed(2) + 's';
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length / 1000;
      avgIntervalEl.textContent = avg.toFixed(2) + 's';
    } else {
      lastIntervalEl.textContent = '—';
      avgIntervalEl.textContent = '—';
    }
  }

  async function detectLoop() {
    if (!running || !detector) return;

    try {
      const poses = await detector.estimatePoses(videoEl, { flipHorizontal: false });
      const pose = poses[0];
      if (pose && pose.keypoints?.length) {
        const { shoulder, elbow } = chooseSide(pose.keypoints);
        if (shoulder && elbow && (shoulder.score ?? 0) >= SCORE_THRESHOLD && (elbow.score ?? 0) >= SCORE_THRESHOLD) {
          drawOverlay(shoulder, elbow);

          const vh = videoEl.videoHeight || videoEl.getBoundingClientRect().height;
          const aboveMarginPx = vh * ABOVE_MARGIN_RATIO;
          const belowMarginPx = vh * BELOW_MARGIN_RATIO;

          const delta = shoulder.y - elbow.y; // positive if elbow above shoulder

          if (delta < -belowMarginPx) {
            phase = 'below';
          }

          if (phase === 'below' && delta > aboveMarginPx) {
            repCount += 1;
            const now = performance.now();
            if (lastRepTime > 0) {
              intervals.push(now - lastRepTime);
            }
            lastRepTime = now;
            phase = 'above';
            updateStats();
            
            // Track rep completion
            if (typeof va !== 'undefined') {
              va.track('rep_completed', { rep_count: repCount });
            }
          }

          repStateEl.textContent = phase;
        } else {
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
          repStateEl.textContent = 'waiting';
        }
      } else {
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        repStateEl.textContent = 'waiting';
      }
    } catch (err) {
      console.error('detectLoop error', err);
    }

    rafId = requestAnimationFrame(detectLoop);
  }
})();
