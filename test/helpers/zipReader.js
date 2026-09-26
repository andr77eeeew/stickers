const assert = require('node:assert/strict');
const zlib = require('zlib');

// Reads a stored ZIP through its central directory and checks every CRC.
function readZip(buffer) {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endOffset >= 0, 'end of central directory present');
  const count = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const flags = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 16);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength;
    const data = buffer.subarray(dataStart, dataStart + size);
    assert.equal(zlib.crc32(data) >>> 0, crc, `CRC of ${name}`);
    assert.equal(flags & 0x0800, 0x0800, 'UTF-8 names');
    entries.push({ name, data });
    offset += 46 + nameLength;
  }
  return entries;
}

module.exports = { readZip };
