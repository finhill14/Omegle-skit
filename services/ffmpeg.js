const { spawn } = require('child_process');
const EventEmitter = require('events');

const jobs = new Map();

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      resolve(parseFloat(out.trim()) || 0);
    });
  });
}

function probeHasAudio(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      resolve(out.trim().length > 0);
    });
  });
}

async function mergeVideos(jobId, prerecordedPath, webcamPath, outputPath) {
  const emitter = new EventEmitter();
  jobs.set(jobId, emitter);

  try {
    const [duration, hasAudio0, hasAudio1] = await Promise.all([
      probeDuration(prerecordedPath),
      probeHasAudio(prerecordedPath),
      probeHasAudio(webcamPath)
    ]);

    const inputs = ['-i', prerecordedPath, '-i', webcamPath];
    let filterParts = [];

    if (!hasAudio0) {
      inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    }
    if (!hasAudio1) {
      inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    }

    filterParts.push(
      '[0:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2:black,setsar=1[top]',
      '[1:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2:black,setsar=1[bottom]',
      '[top][bottom]vstack=inputs=2[v]'
    );

    let audioSource0 = hasAudio0 ? '0:a' : `${2}:a`;
    let audioSource1 = hasAudio1 ? '1:a' : `${hasAudio0 ? 2 : 3}:a`;
    filterParts.push(`[${audioSource0}][${audioSource1}]amix=inputs=2:duration=shortest[a]`);

    const filterComplex = filterParts.join(';');

    const args = [
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-y', outputPath
    ];

    const proc = spawn('ffmpeg', args);
    let stderr = '';

    proc.stdout.on('data', data => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const us = parseInt(line.split('=')[1]);
          if (!isNaN(us) && duration > 0) {
            const percent = Math.min(100, Math.round((us / 1000000 / duration) * 100));
            emitter.emit('progress', { percent });
          }
        }
      }
    });

    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      if (code === 0) {
        emitter.emit('done', { outputPath });
      } else {
        emitter.emit('error', { message: `FFmpeg exited with code ${code}`, details: stderr.slice(-500) });
      }
      setTimeout(() => jobs.delete(jobId), 60000);
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      emitter.emit('error', { message: 'FFmpeg timed out after 10 minutes' });
      jobs.delete(jobId);
    }, 600000);

    proc.on('close', () => clearTimeout(timeout));

  } catch (err) {
    emitter.emit('error', { message: err.message });
    jobs.delete(jobId);
  }

  return emitter;
}

module.exports = { mergeVideos, jobs };
