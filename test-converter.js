const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');

console.log('==================================================');
console.log('       STICKER CONVERSION TEST RUNNER             ');
console.log('==================================================');
console.log(`FFmpeg Binary Location: ${ffmpegPath}`);

async function runTest() {
  const testFile = process.argv[2];
  if (!testFile) {
    console.log('\nUsage: node test-converter.js <path-to-webp-file>');
    console.log('Please provide a path to a WebP file (static or animated) to test the converter.');
    return;
  }

  const absPath = path.resolve(testFile);
  if (!fs.existsSync(absPath)) {
    console.error(`\nError: File not found at ${absPath}`);
    return;
  }

  console.log(`\nReading image metadata: ${path.basename(absPath)}...`);
  try {
    const sharpImg = sharp(absPath, { animated: true });
    const metadata = await sharpImg.metadata();
    
    const isAnimated = metadata.pages > 1;
    console.log(`- Format: ${metadata.format}`);
    console.log(`- Dimensions: ${metadata.width}x${metadata.pageHeight || metadata.height} px`);
    console.log(`- Is Animated: ${isAnimated}`);
    console.log(`- Total Frames: ${metadata.pages || 1}`);

    // Create a local test output folder
    const testOutDir = path.join(__dirname, 'test_output');
    if (!fs.existsSync(testOutDir)) {
      fs.mkdirSync(testOutDir);
    }

    const w = metadata.width;
    const h = metadata.pageHeight || metadata.height;
    let targetW, targetH;

    if (w >= h) {
      targetW = 512;
      targetH = Math.round((h * 512) / w);
    } else {
      targetH = 512;
      targetW = Math.round((w * 512) / h);
    }

    console.log(`- Target Dimensions: ${targetW}x${targetH} px (Fits inside 512x512 with one side exactly 512px)`);

    if (isAnimated) {
      console.log('\n[TEST] Converting animated WebP to transparent WebM VP9...');
      
      const tempFramesDir = path.join(testOutDir, 'temp_frames');
      if (fs.existsSync(tempFramesDir)) {
        fs.rmSync(tempFramesDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tempFramesDir);

      const totalFrames = metadata.pages;
      let totalDurationMs = 0;
      if (metadata.delay && Array.isArray(metadata.delay)) {
        totalDurationMs = metadata.delay.reduce((sum, d) => sum + d, 0);
      } else if (metadata.delay) {
        totalDurationMs = metadata.delay * totalFrames;
      } else {
        totalDurationMs = totalFrames * 40; // 25fps default
      }

      const originalFps = (totalFrames / totalDurationMs) * 1000 || 25;
      const targetFps = Math.min(30, Math.round(originalFps));
      
      const maxDurationMs = 3000;
      let framesToExtract = totalFrames;
      if (totalDurationMs > maxDurationMs) {
        framesToExtract = Math.min(totalFrames, Math.ceil((maxDurationMs / 1000) * targetFps));
      }

      console.log(`- Extracted Duration: ${(totalDurationMs / 1000).toFixed(2)}s`);
      console.log(`- Extracting ${framesToExtract} frames...`);

      for (let i = 0; i < framesToExtract; i++) {
        const framePath = path.join(tempFramesDir, `frame_${String(i).padStart(4, '0')}.png`);
        await sharpImg.clone()
          .extract({
            left: 0,
            top: i * h,
            width: w,
            height: h
          })
          .resize(targetW, targetH)
          .png()
          .toFile(framePath);
      }

      const outPath = path.join(testOutDir, 'test_output_animated.webm');
      console.log(`- Compiling to: ${outPath}...`);

      const ffmpegArgs = [
        '-y',
        '-framerate', String(targetFps),
        '-i', path.join(tempFramesDir, 'frame_%04d.png'),
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuva420p',
        '-lag-in-frames', '0',
        '-auto-alt-ref', '0',
        '-b:v', '0',
        '-crf', '32',
        '-an',
        outPath
      ];

      const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);
      
      let errorMsg = '';
      ffmpegProcess.stderr.on('data', (d) => errorMsg += d.toString());

      ffmpegProcess.on('close', (code) => {
        // Cleanup frames
        try {
          fs.rmSync(tempFramesDir, { recursive: true, force: true });
        } catch (e) {}

        if (code === 0) {
          const stats = fs.statSync(outPath);
          console.log('\n✅ Animated sticker conversion completed successfully!');
          console.log(`- Output File: ${outPath}`);
          console.log(`- Output File Size: ${(stats.size / 1024).toFixed(2)} KB (Telegram limit: 256 KB)`);
        } else {
          console.error(`\n❌ FFmpeg failed with exit code: ${code}`);
          console.error(`Error details: ${errorMsg}`);
        }
      });

    } else {
      console.log('\n[TEST] Converting static WebP to Telegram compliant WebP...');
      const outPath = path.join(testOutDir, 'test_output_static.webp');

      await sharpImg
        .resize(targetW, targetH)
        .webp({ quality: 90 })
        .toFile(outPath);

      const stats = fs.statSync(outPath);
      console.log('\n✅ Static sticker conversion completed successfully!');
      console.log(`- Output File: ${outPath}`);
      console.log(`- Output File Size: ${(stats.size / 1024).toFixed(2)} KB (Telegram limit: 512 KB)`);
    }

  } catch (err) {
    console.error('\n❌ Test run failed with error:', err);
  }
}

runTest();
