/**
 * Quick verification of isTikTokDmStickerUrl against known good/bad samples
 * from output/stickers_db.json (historical captures).
 *
 * Run: node test-sticker-filter.js
 */

const { isTikTokDmStickerUrl } = require('./lib/stickerUrl');

const shouldReject = [
  'https://p16-common-sign.tiktokcdn.com/musically-maliva-obj/1594805258216454~tplv-tiktokx-cropcenter:720:720.jpeg?x=1',
  'https://p16-common-sign.tiktokcdn.com/tos-maliva-avt-0068/52ccdb3a692e329d7ce0e8a2efb7945b~tplv-tiktokx-cropcenter:168:168.jpeg?x=1',
  'https://p16-sign.tiktokcdn.com/tos-maliva-avt-0068/abc.jpeg',
  'https://www.tiktok.com/api/something'
];

const shouldAccept = [
  'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/tos-alisg-i-dhq7zx4c1p-sg/ea9e25ef87ca441493659a7001eeb5cf~tplv-dhq7zx4c1p-full.awebp?rk3s=00edd399',
  'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/tos-alisg-i-dhq7zx4c1p-sg/625c6d1a6b61448eb84627e9dd378fd7~tplv-dhq7zx4c1p-video2sticker-mid.awebp?x=1',
  'https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/tos-alisg-i-dhq7zx4c1p-sg/4834bc21127e4d0b9fd118b943896ea4~tplv-dhq7zx4c1p-photo-comment-full.awebp?x=1'
];

let failed = 0;

for (const url of shouldReject) {
  const ok = isTikTokDmStickerUrl(url);
  if (ok) {
    console.error('FAIL expected reject:', url);
    failed++;
  } else {
    console.log('OK reject:', url.slice(0, 80) + '...');
  }
}

for (const url of shouldAccept) {
  const ok = isTikTokDmStickerUrl(url);
  if (!ok) {
    console.error('FAIL expected accept:', url);
    failed++;
  } else {
    console.log('OK accept:', url.slice(0, 80) + '...');
  }
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}

console.log('\nAll sticker URL filter assertions passed.');
