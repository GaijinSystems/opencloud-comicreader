/*
 * Thin C surface over 7-Zip's 7z reader for use from JavaScript.
 * Part of OpenCloud Comic Reader, AGPL-3.0-or-later. Not part of 7-Zip.
 *
 * Plain exported functions and four imported ones: no Embind, so the
 * generated loader never builds code from strings and needs no 'unsafe-eval'
 * in the page's CSP.
 *
 * The archive is not copied into this module's memory. 7-Zip asks for the
 * parts of it that it wants, and this file passes each request on to a hook
 * the caller sets on the module object:
 *
 *   crRead(position, pointer, count) -> how many bytes were put at
 *                              `pointer` (0..count, less only at the end
 *                              of the archive), or -1 if reading failed
 *
 * Extraction is one pass over every entry, in the archive's own order: 7-Zip
 * pushes each entry's bytes out as it decodes them, and this file passes
 * them on to three more hooks:
 *
 *   crBegin(index)          -> 1 to go on, 0 to stop the whole pass
 *   crWrite(pointer, count) -> 1 to go on, 0 to stop the whole pass
 *   crEnd(index, result)       result is 0 when the entry decoded cleanly
 *                              and its checksum matched (7-Zip's
 *                              NExtract::NOperationResult otherwise)
 *
 * None of the four may throw: they are called from inside 7-Zip functions
 * that are declared not to, and an exception passing through one aborts the
 * module. sevenzip-extract.mjs catches in each hook and rethrows once the
 * call into this file has returned.
 *
 * crEnd is also called, with a failure, for entries that never began: when a
 * block of entries turns out to be undecodable, 7-Zip reports each of the
 * entries left in it that way.
 */
#include "../../../Common/MyWindows.h"
#include "../../../Common/MyInitGuid.h"

#include <emscripten.h>
#include <new>

#include "../../../../C/7zCrc.h"

#include "../../../Common/MyCom.h"
#include "../../../Common/MyString.h"
#include "../../../Common/UTFConvert.h"
#include "../../../Windows/PropVariant.h"

#include "../../Common/StreamObjects.h"
#include "../../Archive/IArchive.h"
#include "../../Archive/7z/7zHandler.h"
#include "../../IPassword.h"
#include "../../PropID.h"
#include "../../../../C/Sha1.h"
#include "../../Crypto/Rar20Crypto.h"
#include "../../Crypto/Rar5Aes.h"
#include "../../Crypto/RarAes.h"
#include "../../Crypto/WzAes.h"

/*
 * Stands in for Windows/System.cpp, which is not compiled: it asks the
 * operating system how much memory the machine has, and there is none to
 * ask. 7-Zip sizes its limit on a decoder's memory from the answer. The
 * honest one here is the most this module's heap can ever hold.
 */
namespace NWindows {
namespace NSystem {
bool GetRamSize(size_t &size);
bool GetRamSize(size_t &size)
{
  size = (size_t)1 << 31;
  return true;
}
}}

EM_JS(int, cr7_js_read, (double position, void *data, unsigned count), {
  return Module['crRead'](position, data, count);
})
EM_JS(int, cr7_js_begin, (unsigned index), { return Module['crBegin'](index) ? 1 : 0; })
EM_JS(int, cr7_js_write, (const void *data, unsigned count), {
  return Module['crWrite'](data, count) ? 1 : 0;
})
EM_JS(void, cr7_js_end, (unsigned index, int result), { Module['crEnd'](index, result); })

/* Why the last cr7_open() returned NULL. */
enum {
  kOpenOk = 0,
  kOpenNotAnArchive = 1, /* not 7z, damaged, unreadable, or its listing
                            does not fit in memory */
  kOpenPassword = 2      /* the headers are encrypted, and there was no
                            password or they would not open with it */
};
static int g_openError = kOpenOk;

/* The password, and whether 7-Zip asked for it. */
struct CPassword {
  bool Defined;
  bool Asked;
  UString Text;
  CPassword() : Defined(false), Asked(false) {}

  HRESULT Get(BSTR *password)
  {
    Asked = true;
    if (!Defined)
      return E_ABORT;
    return StringToBstr(Text, password);
  }
};

/* The archive, read through the caller's crRead hook. */
Z7_CLASS_IMP_IInStream(
  CHookInStream
)
  UInt64 _pos;
  UInt64 _size;
public:
  void Init(UInt64 size)
  {
    _pos = 0;
    _size = size;
  }
};

Z7_COM7F_IMF(CHookInStream::Read(void *data, UInt32 size, UInt32 *processedSize))
{
  if (processedSize)
    *processedSize = 0;
  if (size == 0 || _pos >= _size)
    return S_OK;
  const UInt64 rem = _size - _pos;
  if (size > rem)
    size = (UInt32)rem;
  const int got = cr7_js_read((double)_pos, data, size);
  /* Never more than was asked for: `data` has room for `size` and no more. */
  if (got < 0 || (UInt32)got > size)
    return E_FAIL;
  _pos += (UInt32)got;
  if (processedSize)
    *processedSize = (UInt32)got;
  return S_OK;
}

Z7_COM7F_IMF(CHookInStream::Seek(Int64 offset, UInt32 seekOrigin, UInt64 *newPosition))
{
  switch (seekOrigin)
  {
    case STREAM_SEEK_SET: break;
    case STREAM_SEEK_CUR: offset += (Int64)_pos; break;
    case STREAM_SEEK_END: offset += (Int64)_size; break;
    default: return STG_E_INVALIDFUNCTION;
  }
  if (offset < 0)
    return HRESULT_WIN32_ERROR_NEGATIVE_SEEK;
  _pos = (UInt64)offset;
  if (newPosition)
    *newPosition = (UInt64)offset;
  return S_OK;
}

class COpenCallback Z7_final:
  public IArchiveOpenCallback,
  public ICryptoGetTextPassword,
  public CMyUnknownImp
{
  Z7_IFACES_IMP_UNK_2(IArchiveOpenCallback, ICryptoGetTextPassword)
public:
  CPassword *Password;
};

Z7_COM7F_IMF(COpenCallback::SetTotal(const UInt64 *, const UInt64 *)) { return S_OK; }
Z7_COM7F_IMF(COpenCallback::SetCompleted(const UInt64 *, const UInt64 *)) { return S_OK; }
Z7_COM7F_IMF(COpenCallback::CryptoGetTextPassword(BSTR *password)) { return Password->Get(password); }

class COutStream Z7_final:
  public ISequentialOutStream,
  public CMyUnknownImp
{
  Z7_IFACES_IMP_UNK_1(ISequentialOutStream)
};

Z7_COM7F_IMF(COutStream::Write(const void *data, UInt32 size, UInt32 *processedSize))
{
  if (processedSize)
    *processedSize = size;
  if (size != 0 && !cr7_js_write(data, size))
    return E_ABORT;
  return S_OK;
}

class CExtractCallback Z7_final:
  public IArchiveExtractCallback,
  public ICryptoGetTextPassword,
  public CMyUnknownImp
{
  Z7_IFACES_IMP_UNK_2(IArchiveExtractCallback, ICryptoGetTextPassword)
  Z7_IFACE_COM7_IMP(IProgress)
  UInt32 _index;
public:
  CPassword *Password;
  CExtractCallback() : _index(0) {}
};

Z7_COM7F_IMF(CExtractCallback::SetTotal(UInt64)) { return S_OK; }
Z7_COM7F_IMF(CExtractCallback::SetCompleted(const UInt64 *)) { return S_OK; }

Z7_COM7F_IMF(CExtractCallback::GetStream(UInt32 index, ISequentialOutStream **outStream,
    Int32 askExtractMode))
{
  *outStream = NULL;
  _index = index;
  /* Anything else is 7-Zip passing over an entry it cannot decode. */
  if (askExtractMode != NArchive::NExtract::NAskMode::kExtract)
    return S_OK;
  if (!cr7_js_begin(index))
    return E_ABORT;
  /* nothrow: this function may not throw, and plain new does when the heap
     is exhausted. */
  COutStream *streamSpec = new(std::nothrow) COutStream;
  if (!streamSpec)
    return E_OUTOFMEMORY;
  CMyComPtr<ISequentialOutStream> stream = streamSpec;
  *outStream = stream.Detach();
  return S_OK;
}

Z7_COM7F_IMF(CExtractCallback::PrepareOperation(Int32)) { return S_OK; }

Z7_COM7F_IMF(CExtractCallback::SetOperationResult(Int32 result))
{
  cr7_js_end(_index, result);
  return S_OK;
}

Z7_COM7F_IMF(CExtractCallback::CryptoGetTextPassword(BSTR *password)) { return Password->Get(password); }

struct cr7_handle {
  CMyComPtr<IInArchive> Archive;
  CPassword Password;
  UInt32 Count;
  AString Name; /* the last name asked for */
};

extern "C" {

EMSCRIPTEN_KEEPALIVE int cr7_open_error(void)
{
  return g_openError;
}

/*
 * `length` is the archive's size in bytes (a double: it may exceed 32 bits);
 * its contents come through the crRead hook. `password` is UTF-8, or NULL
 * when there is none. Returns NULL when the archive cannot be opened;
 * cr7_open_error() then says why.
 */
EMSCRIPTEN_KEEPALIVE cr7_handle *cr7_open(double length, const char *password)
{
  g_openError = kOpenNotAnArchive;
  /* A size that is not a whole number of bytes below 2^53 is no size. */
  if (!(length >= 0 && length < 9007199254740992.0 && length == (double)(UInt64)length))
    return NULL;
  cr7_handle *handle = NULL;
  try
  {
    handle = new cr7_handle;
    if (password)
    {
      handle->Password.Defined = true;
      if (!ConvertUTF8ToUnicode(AString(password), handle->Password.Text))
      {
        delete handle;
        return NULL;
      }
    }

    CHookInStream *streamSpec = new CHookInStream;
    CMyComPtr<IInStream> stream = streamSpec;
    streamSpec->Init((UInt64)length);

    COpenCallback *callbackSpec = new COpenCallback;
    CMyComPtr<IArchiveOpenCallback> callback = callbackSpec;
    callbackSpec->Password = &handle->Password;

    handle->Archive = new NArchive::N7z::CHandler;
    const UInt64 scanSize = 1 << 23;
    UInt32 count = 0;
    if (handle->Archive->Open(stream, &scanSize, callback) != S_OK ||
        handle->Archive->GetNumberOfItems(&count) != S_OK)
    {
      if (handle->Password.Asked)
        g_openError = kOpenPassword;
      handle->Archive->Close();
      delete handle;
      return NULL;
    }
    handle->Count = count;
    g_openError = kOpenOk;
    return handle;
  }
  catch (...)
  {
    delete handle;
    return NULL;
  }
}

EMSCRIPTEN_KEEPALIVE unsigned cr7_count(cr7_handle *handle)
{
  return handle->Count;
}

/* Reads one property of an entry; false unless it is there with this type. */
static bool Property(cr7_handle *handle, unsigned index, PROPID id, VARTYPE type,
    NWindows::NCOM::CPropVariant &prop)
{
  /* 7-Zip does not check the index itself. */
  if (index >= handle->Count)
    return false;
  try
  {
    return handle->Archive->GetProperty(index, id, &prop) == S_OK && prop.vt == type;
  }
  catch (...)
  {
    return false;
  }
}

/* UTF-8, valid until the next call for a name. NULL when there is none. */
EMSCRIPTEN_KEEPALIVE const char *cr7_entry_name(cr7_handle *handle, unsigned index)
{
  NWindows::NCOM::CPropVariant prop;
  if (!Property(handle, index, kpidPath, VT_BSTR, prop))
    return NULL;
  try
  {
    ConvertUnicodeToUTF8(UString(prop.bstrVal), handle->Name);
    return handle->Name.Ptr();
  }
  catch (...)
  {
    return NULL;
  }
}

/* A double, because the declared size is 64 bits wide. -1 when unknown. */
EMSCRIPTEN_KEEPALIVE double cr7_entry_size(cr7_handle *handle, unsigned index)
{
  NWindows::NCOM::CPropVariant prop;
  return Property(handle, index, kpidSize, VT_UI8, prop) ? (double)prop.uhVal.QuadPart : -1;
}

static int BoolProperty(cr7_handle *handle, unsigned index, PROPID id)
{
  NWindows::NCOM::CPropVariant prop;
  return Property(handle, index, id, VT_BOOL, prop) && prop.boolVal != VARIANT_FALSE ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int cr7_entry_is_directory(cr7_handle *handle, unsigned index)
{
  return BoolProperty(handle, index, kpidIsDir);
}

EMSCRIPTEN_KEEPALIVE int cr7_entry_is_encrypted(cr7_handle *handle, unsigned index)
{
  return BoolProperty(handle, index, kpidEncrypted);
}

/*
 * Whether the archive records a checksum for the entry. Without one, 7-Zip
 * has nothing to check the decoded bytes against and reports success
 * whatever came out.
 */
EMSCRIPTEN_KEEPALIVE int cr7_entry_has_checksum(cr7_handle *handle, unsigned index)
{
  NWindows::NCOM::CPropVariant prop;
  return Property(handle, index, kpidCRC, VT_UI4, prop) ? 1 : 0;
}

/*
 * Decodes every entry, in order, through the three hooks. Returns 0 when it
 * ran to the end, 2 when it ran out of memory, and 1 when it stopped for any
 * other reason: a hook stopped it, or 7-Zip gave up (damaged data it could
 * not get past, an unsupported method).
 */
EMSCRIPTEN_KEEPALIVE int cr7_extract(cr7_handle *handle)
{
  try
  {
    CExtractCallback *callbackSpec = new CExtractCallback;
    CMyComPtr<IArchiveExtractCallback> callback = callbackSpec;
    callbackSpec->Password = &handle->Password;
    const HRESULT result = handle->Archive->Extract(NULL, (UInt32)(Int32)-1, 0, callback);
    if (result == S_OK)
      return 0;
    return result == E_OUTOFMEMORY ? 2 : 1;
  }
  catch (const CNewException &)
  {
    return 2;
  }
  catch (...)
  {
    return 1;
  }
}

/* Whether 7-Zip has asked for the password since cr7_open() was called. */
EMSCRIPTEN_KEEPALIVE int cr7_password_asked(cr7_handle *handle)
{
  return handle->Password.Asked ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void cr7_close(cr7_handle *handle)
{
  if (!handle)
    return;
  try
  {
    handle->Archive->Close();
  }
  catch (...)
  {
  }
  delete handle;
}

/*
 * Decryption on its own, for the archives the reader's other decoders can
 * decompress but not decrypt: RAR (versions 2 to 5) and zip with WinZip AES.
 * The caller walks the container, hands each encrypted run of bytes through
 * one of these, and writes out an archive that is no longer encrypted.
 *
 * These are 7-Zip's decryption routines (CPP/7zip/Crypto, LGPL). No RAR
 * decompression code is involved: that is what carries 7-Zip's unRAR
 * licence restriction, and none of it is compiled.
 *
 * A password arrives as the bytes each format hashes: UTF-8 for RAR5 and
 * zip, UTF-16LE for RAR3, the writer's own bytes for RAR 2.0. The caller
 * encodes it.
 */
struct cr7_cipher {
  CMyComPtr<ICompressFilter> Filter;
  NCrypto::NRar5::CDecoder *Rar5;
  NCrypto::NRar3::CDecoder *Rar3;
  NCrypto::NRar2::CDecoder *Rar2;
  NCrypto::NWzAes::CDecoder *Wz;
  /* RAR5: the record holds a password check value, and that value is intact. */
  bool Verifies;
  cr7_cipher() : Rar5(NULL), Rar3(NULL), Rar2(NULL), Wz(NULL), Verifies(false) {}
};

/* Builds a cipher with `setup`; NULL if that says no, or throws. */
extern "C++" {
template <class Setup> static cr7_cipher *MakeCipher(Setup setup)
{
  cr7_cipher *cipher = NULL;
  try
  {
    cipher = new cr7_cipher;
    if (setup(cipher))
      return cipher;
  }
  catch (...)
  {
  }
  delete cipher;
  return NULL;
}
}

/*
 * Whether a RAR5 encryption record carries a password check value that can
 * be relied on. The record ends with eight bytes of check value and the
 * first four bytes of their SHA-256. Where those four do not match, 7-Zip
 * (like RAR) takes the check value for damaged and accepts any password
 * without a word, so whether a check really took place has to be worked
 * out here. Called on a record SetDecoderProps has accepted, so its length
 * is known to fit its flags.
 */
static bool Rar5CheckValueIsIntact(const Byte *props, unsigned size)
{
  /* The version (one byte: 7-Zip accepts only 0), then the flags. */
  UInt64 flags = 0;
  unsigned at = 1;
  for (unsigned shift = 0; at < size && shift < 64; shift += 7)
  {
    const Byte b = props[at++];
    flags |= (UInt64)(b & 0x7F) << shift;
    if ((b & 0x80) == 0)
      break;
  }
  const unsigned kCheck = 8, kSum = 4;
  if ((flags & NCrypto::NRar5::NCryptoFlags::kPswCheck) == 0 || size < at + kCheck + kSum)
    return false;
  CSha256 sha;
  Byte digest[SHA256_DIGEST_SIZE];
  Sha256_Init(&sha);
  Sha256_Update(&sha, props + size - kCheck - kSum, kCheck);
  Sha256_Final(&sha, digest);
  return memcmp(digest, props + size - kSum, kSum) == 0;
}

/*
 * RAR5. `props` is the encryption record as the archive holds it, from its
 * version field on; `includeIV` says whether it carries an IV (a file's
 * record does, the archive's header-encryption record does not, see
 * cr7_cipher_set_iv). NULL when the record is of a kind 7-Zip does not
 * know.
 */
EMSCRIPTEN_KEEPALIVE cr7_cipher *cr7_cipher_rar5(const void *password, unsigned passwordSize,
    const void *props, unsigned propsSize, int includeIV)
{
  return MakeCipher([&](cr7_cipher *cipher) {
    cipher->Rar5 = new NCrypto::NRar5::CDecoder;
    cipher->Filter = cipher->Rar5;
    /* The last argument is for service blocks, which the caller drops. */
    if (cipher->Rar5->SetDecoderProps((const Byte *)props, propsSize, includeIV != 0, false) != S_OK)
      return false;
    cipher->Rar5->SetPassword((const Byte *)password, passwordSize);
    cipher->Verifies = Rar5CheckValueIsIntact((const Byte *)props, propsSize);
    return true;
  });
}

/* RAR5 with encrypted headers: each header comes with an IV of its own. */
EMSCRIPTEN_KEEPALIVE void cr7_cipher_set_iv(cr7_cipher *cipher, const void *iv)
{
  if (cipher->Rar5)
    memcpy(cipher->Rar5->_iv, iv, AES_BLOCK_SIZE);
}

/*
 * RAR3 (and 4). One cipher serves a whole archive: give it each entry's
 * salt with cr7_cipher_rar3_salt and start it again. 7-Zip derives the key
 * anew only when the salt differs from the last one, and that derivation
 * is the slow part.
 */
EMSCRIPTEN_KEEPALIVE cr7_cipher *cr7_cipher_rar3(const void *password, unsigned passwordSize)
{
  return MakeCipher([&](cr7_cipher *cipher) {
    cipher->Rar3 = new NCrypto::NRar3::CDecoder;
    cipher->Filter = cipher->Rar3;
    cipher->Rar3->SetPassword((const Byte *)password, passwordSize);
    return true;
  });
}

/* `salt` is 8 bytes, or NULL when the entry has none. 1 when taken. */
EMSCRIPTEN_KEEPALIVE int cr7_cipher_rar3_salt(cr7_cipher *cipher, const void *salt)
{
  return cipher->Rar3 && cipher->Rar3->SetDecoderProperties2((const Byte *)salt, salt ? 8 : 0) == S_OK ? 1 : 0;
}

/*
 * RAR 2.0, the cipher RAR used before AES (unpacker versions 2.0 to 2.8).
 * The password is the bytes the archive's writer typed, 127 at most. The
 * cipher's state runs on from block to block, so one of these serves one
 * entry: make another for the next. There is no salt and no check.
 */
EMSCRIPTEN_KEEPALIVE cr7_cipher *cr7_cipher_rar2(const void *password, unsigned passwordSize)
{
  return MakeCipher([&](cr7_cipher *cipher) {
    cipher->Rar2 = new NCrypto::NRar2::CDecoder;
    cipher->Filter = cipher->Rar2;
    cipher->Rar2->SetPassword((const Byte *)password, passwordSize);
    return true;
  });
}

/*
 * WinZip AES. `mode` is the key strength as the zip records it (1 to 3);
 * `header` is what precedes the entry's data: the salt (8, 12 or 16 bytes
 * by mode) and the two password-verification bytes.
 *
 * 7-Zip takes a password of 99 bytes at most. The scheme itself has no
 * such limit, and a longer one need not be turned away: the key comes from
 * PBKDF2 over HMAC-SHA-1, and HMAC replaces any key longer than its block
 * of 64 bytes with that key's SHA-1. So a long password and its SHA-1 give
 * the same key, and the SHA-1 is what 7-Zip is handed.
 */
EMSCRIPTEN_KEEPALIVE cr7_cipher *cr7_cipher_wzaes(const void *password, unsigned passwordSize,
    unsigned mode, const void *header)
{
  return MakeCipher([&](cr7_cipher *cipher) {
    cipher->Wz = new NCrypto::NWzAes::CDecoder;
    cipher->Filter = cipher->Wz;
    Byte digest[SHA1_DIGEST_SIZE];
    if (passwordSize > 64)
    {
      CSha1 sha;
      Sha1_Init(&sha);
      Sha1_Update(&sha, (const Byte *)password, passwordSize);
      Sha1_Final(&sha, digest);
      password = digest;
      passwordSize = SHA1_DIGEST_SIZE;
    }
    if (!cipher->Wz->SetKeyMode(mode) ||
        cipher->Wz->CryptoSetPassword((const Byte *)password, passwordSize) != S_OK)
      return false;
    CBufInStream *streamSpec = new CBufInStream;
    CMyComPtr<ISequentialInStream> stream = streamSpec;
    streamSpec->Init((const Byte *)header, cipher->Wz->GetHeaderSize());
    return cipher->Wz->ReadHeader(stream) == S_OK;
  });
}

/*
 * Derives the key and makes the cipher ready. 2: ready, and the archive's
 * own check confirmed the password. 1: ready, with nothing to check the
 * password by (RAR 2.0 and RAR3 always; RAR5 when the archive recorded no
 * check value, or a damaged one). 0: the archive's own check says the password is
 * wrong. -1: failed otherwise.
 */
EMSCRIPTEN_KEEPALIVE int cr7_cipher_start(cr7_cipher *cipher)
{
  try
  {
    if (cipher->Rar5 && !cipher->Rar5->CalcKey_and_CheckPassword())
      return 0;
    if (cipher->Wz)
      return cipher->Wz->Init_and_CheckPassword() ? 1 : 0;
    if (cipher->Filter->Init() != S_OK)
      return -1;
    return cipher->Rar5 && cipher->Verifies ? 2 : 1;
  }
  catch (...)
  {
    return -1;
  }
}

/*
 * Decrypts in place and returns how many bytes were done. RAR works in
 * blocks of 16: give it whole blocks. Calls continue one another.
 */
EMSCRIPTEN_KEEPALIVE unsigned cr7_cipher_decrypt(cr7_cipher *cipher, void *data, unsigned size)
{
  try
  {
    const UInt32 done = cipher->Filter->Filter((Byte *)data, size);
    return done > size ? 0 : done;
  }
  catch (...)
  {
    return 0;
  }
}

/* RAR5: what a checksum of the plain data is stored as when the archive tweaks them. */
EMSCRIPTEN_KEEPALIVE unsigned cr7_cipher_rar5_checksum(cr7_cipher *cipher, unsigned crc)
{
  return cipher->Rar5 && cipher->Rar5->UseMAC() ? cipher->Rar5->Hmac_Convert_Crc32(crc) : crc;
}

/* WinZip AES: whether the 10 bytes after the entry's data authenticate it. */
EMSCRIPTEN_KEEPALIVE int cr7_cipher_wzaes_check(cr7_cipher *cipher, const void *mac)
{
  try
  {
    if (!cipher->Wz)
      return 0;
    CBufInStream *streamSpec = new CBufInStream;
    CMyComPtr<ISequentialInStream> stream = streamSpec;
    streamSpec->Init((const Byte *)mac, NCrypto::NWzAes::kMacSize);
    bool ok = false;
    return cipher->Wz->CheckMac(stream, ok) == S_OK && ok ? 1 : 0;
  }
  catch (...)
  {
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE void cr7_cipher_free(cr7_cipher *cipher)
{
  delete cipher;
}

/*
 * A CRC-32 carried over `size` more bytes. `state` is the running value as
 * 7-Zip keeps it: 0xFFFFFFFF to begin with, and inverted at the end to get
 * the checksum. For the checksums of stored entries, which are computed
 * over what was just decrypted while it is still in the heap.
 */
EMSCRIPTEN_KEEPALIVE unsigned cr7_crc(unsigned state, const void *data, unsigned size)
{
  return CrcUpdate(state, data, size);
}

}
