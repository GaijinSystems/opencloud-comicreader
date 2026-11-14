#!/usr/bin/env python3
"""
Writes a minimal RAR 4.x archive with stored (uncompressed) members.

Creating RAR normally needs the proprietary `rar` tool, which is why the plan
originally said `sample.cbr` had to be committed by hand. The RAR 4 container
is documented well enough to emit directly, though, and stored members need no
compressor at all. That is enough to exercise the CBR code path end to end
against the real libarchive decoder.

This is a test fixture writer, not a general RAR implementation: it only emits
what libarchive needs to enumerate and extract stored files.

With a password, the members are encrypted the way RAR 2.x did it, before
AES: no current `rar` writes that any more, which is why the fixtures for it
are made here. The cipher is the one documented by its free implementations
(7-Zip's Crypto/Rar20Crypto.cpp, The Unarchiver); what this writes is checked
against RARLAB's own unrar by scripts/check-rar2-fixture.sh.
"""

import struct
import zlib

MARKER = bytes([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00])

BLOCK_MAIN = 0x73
BLOCK_FILE = 0x74
BLOCK_END = 0x7B

# Set on every block whose size field covers a trailing data area.
FLAG_LONG_BLOCK = 0x8000
# Set on a file block whose data is encrypted.
FLAG_PASSWORD = 0x0004

METHOD_STORE = 0x30
UNPACK_VERSION = 20  # RAR 2.0 decoder is enough for stored entries

# Host OS decides how libarchive reads the ATTR field. Under Unix (3) it is
# interpreted as a st_mode, so the archive-bit value 0x20 is not a regular
# file and libarchive silently skips the entry — the archive opens fine and
# simply lists nothing. Windows (2) reads ATTR as DOS attributes, which is
# also what virtually every real .cbr in circulation uses.
HOST_OS_WINDOWS = 2
ATTR_ARCHIVE = 0x20


def head_crc(header_without_crc: bytes) -> int:
    """RAR stores the low 16 bits of the CRC32 taken from HEAD_TYPE onward."""
    return zlib.crc32(header_without_crc) & 0xFFFF


def main_block() -> bytes:
    body = struct.pack(
        "<BHHHI",
        BLOCK_MAIN,
        0x0000,  # HEAD_FLAGS
        13,  # HEAD_SIZE
        0,  # RESERVED1
        0,  # RESERVED2
    )
    return struct.pack("<H", head_crc(body)) + body


def dos_timestamp(year=2024, month=1, day=1, hour=0, minute=0, second=0) -> int:
    return (
        ((year - 1980) << 25)
        | (month << 21)
        | (day << 16)
        | (hour << 11)
        | (minute << 5)
        | (second // 2)
    )


_CRC_TABLE = []
for _n in range(256):
    _c = _n
    for _ in range(8):
        _c = (_c >> 1) ^ 0xEDB88320 if _c & 1 else _c >> 1
    _CRC_TABLE.append(_c)

_SUBST = bytes([
    215, 19, 149, 35, 73, 197, 192, 205, 249, 28, 16, 119, 48, 221, 2, 42,
    232, 1, 177, 233, 14, 88, 219, 25, 223, 195, 244, 90, 87, 239, 153, 137,
    255, 199, 147, 70, 92, 66, 246, 13, 216, 40, 62, 29, 217, 230, 86, 6,
    71, 24, 171, 196, 101, 113, 218, 123, 93, 91, 163, 178, 202, 67, 44, 235,
    107, 250, 75, 234, 49, 167, 125, 211, 83, 114, 157, 144, 32, 193, 143, 36,
    158, 124, 247, 187, 89, 214, 141, 47, 121, 228, 61, 130, 213, 194, 174, 251,
    97, 110, 54, 229, 115, 57, 152, 94, 105, 243, 212, 55, 209, 245, 63, 11,
    164, 200, 31, 156, 81, 176, 227, 21, 76, 99, 139, 188, 127, 17, 248, 51,
    207, 120, 189, 210, 8, 226, 41, 72, 183, 203, 135, 165, 166, 60, 98, 7,
    122, 38, 155, 170, 69, 172, 252, 238, 39, 134, 59, 128, 236, 27, 240, 80,
    131, 3, 85, 206, 145, 79, 154, 142, 159, 220, 201, 133, 74, 64, 20, 129,
    224, 185, 138, 103, 173, 182, 43, 34, 254, 82, 198, 151, 231, 180, 58, 10,
    118, 26, 102, 12, 50, 132, 22, 191, 136, 111, 162, 179, 45, 4, 148, 108,
    161, 56, 78, 126, 242, 222, 15, 175, 146, 23, 33, 241, 181, 190, 77, 225,
    0, 46, 169, 186, 68, 95, 237, 65, 53, 208, 253, 168, 9, 18, 100, 52,
    116, 184, 160, 96, 109, 37, 30, 106, 140, 104, 150, 5, 204, 117, 112, 84,
])
_M32 = 0xFFFFFFFF


def _rol(value: int, bits: int) -> int:
    return ((value << bits) | (value >> (32 - bits))) & _M32


class Rar20Cipher:
    """RAR 2.0's block cipher, in the encrypting direction. One per member."""

    def __init__(self, password: bytes):
        self.keys = [0xD3A3B879, 0x3F6D12F7, 0x7515A235, 0xA4E7F123]
        self.subst = bytearray(_SUBST)
        size = min(len(password), 127)
        psw = bytearray(128)
        psw[:size] = password[:size]
        for j in range(256):
            for i in range(0, size, 2):
                n1 = _CRC_TABLE[(psw[i] - j) & 0xFF] & 0xFF
                n2 = _CRC_TABLE[(psw[i + 1] + j) & 0xFF] & 0xFF
                k = 1
                while (n1 & 0xFF) != n2:
                    a, b = n1 & 0xFF, (n1 + i + k) & 0xFF
                    self.subst[a], self.subst[b] = self.subst[b], self.subst[a]
                    n1 += 1
                    k += 1
        for i in range(0, size, 16):
            self.encrypt_block(psw[i:i + 16])

    def _subst_long(self, t: int) -> int:
        s = self.subst
        return s[t & 255] | (s[(t >> 8) & 255] << 8) | (s[(t >> 16) & 255] << 16) | (s[t >> 24] << 24)

    def encrypt_block(self, block: bytes) -> bytes:
        k = self.keys
        a, b, c, d = (word ^ key for word, key in zip(struct.unpack("<4I", bytes(block)), k))
        for i in range(32):
            key = k[i & 3]
            ta = a ^ self._subst_long(((c + _rol(d, 11)) & _M32) ^ key)
            tb = b ^ self._subst_long(((d ^ _rol(c, 17)) + key) & _M32)
            a, c = c, ta
            b, d = d, tb
        out = struct.pack("<4I", c ^ k[0], d ^ k[1], a ^ k[2], b ^ k[3])
        # The keys move on with every block of ciphertext.
        for i in range(0, 16, 4):
            for j in range(4):
                k[j] ^= _CRC_TABLE[out[i + j]]
        return out

    def encrypt(self, data: bytes) -> bytes:
        padded = data + bytes(-len(data) % 16)
        return b"".join(self.encrypt_block(padded[at:at + 16]) for at in range(0, len(padded), 16))


def file_block(name: str, data: bytes, password: bytes = None) -> bytes:
    # RAR uses backslashes as the path separator; libarchive normalises them.
    encoded = name.replace("/", "\\").encode("utf-8")
    head_size = 32 + len(encoded)
    # The checksum and the unpacked size are of the data as it was; what is
    # stored is encrypted, in whole blocks of 16 bytes.
    unpacked = data
    if password is not None:
        data = Rar20Cipher(password).encrypt(data)

    body = struct.pack(
        "<BHHIIBIIBBHI",
        BLOCK_FILE,
        FLAG_LONG_BLOCK | (FLAG_PASSWORD if password is not None else 0),  # HEAD_FLAGS
        head_size,  # HEAD_SIZE
        len(data),  # PACK_SIZE
        len(unpacked),  # UNP_SIZE
        HOST_OS_WINDOWS,  # HOST_OS
        zlib.crc32(unpacked) & 0xFFFFFFFF,  # FILE_CRC
        dos_timestamp(),  # FTIME
        UNPACK_VERSION,  # UNP_VER
        METHOD_STORE,  # METHOD
        len(encoded),  # NAME_SIZE
        ATTR_ARCHIVE,  # ATTR
    ) + encoded

    return struct.pack("<H", head_crc(body)) + body + data


def end_block() -> bytes:
    body = struct.pack("<BHH", BLOCK_END, 0x4000, 7)
    return struct.pack("<H", head_crc(body)) + body


def write_rar(path: str, members: dict, password: str = None) -> None:
    """With a password, every member is encrypted with RAR 2.0's cipher."""
    key = password.encode("utf-8") if password is not None else None
    chunks = [MARKER, main_block()]
    for name, data in members.items():
        chunks.append(file_block(name, data, key))
    chunks.append(end_block())
    with open(path, "wb") as handle:
        handle.write(b"".join(chunks))
