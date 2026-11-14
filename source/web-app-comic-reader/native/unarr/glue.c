/*
 * Thin C surface over unarr's RAR reader for use from JavaScript.
 *
 * Plain exported functions only: no Embind, so the generated loader never
 * builds code from strings and needs no 'unsafe-eval' in the page's CSP.
 *
 * The caller owns the archive bytes (allocated with malloc in this heap) and
 * must keep them alive until cr_close().
 */
#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>

#include "unarr.h"
/* For cr_entry_finish alone, which has to reach inside the decoder. */
#include "upstream/rar/rar.h"

typedef struct {
    ar_stream *stream;
    ar_archive *archive;
} cr_handle;

/* Returns NULL when the bytes are not a RAR archive unarr can read. */
EMSCRIPTEN_KEEPALIVE cr_handle *cr_open(const void *data, size_t length)
{
    cr_handle *handle = calloc(1, sizeof(cr_handle));
    if (!handle)
        return NULL;
    handle->stream = ar_open_memory(data, length);
    if (!handle->stream) {
        free(handle);
        return NULL;
    }
    handle->archive = ar_open_rar_archive(handle->stream);
    if (!handle->archive) {
        ar_close(handle->stream);
        free(handle);
        return NULL;
    }
    return handle;
}

/* 1: positioned on the next entry. 0: clean end of archive. -1: error. */
EMSCRIPTEN_KEEPALIVE int cr_next(cr_handle *handle)
{
    if (ar_parse_entry(handle->archive))
        return 1;
    return ar_at_eof(handle->archive) ? 0 : -1;
}

/* UTF-8, valid until the next cr_next(). May be NULL. */
EMSCRIPTEN_KEEPALIVE const char *cr_entry_name(cr_handle *handle)
{
    return ar_entry_get_name(handle->archive);
}

EMSCRIPTEN_KEEPALIVE uint32_t cr_entry_size(cr_handle *handle)
{
    return (uint32_t)ar_entry_get_size(handle->archive);
}

/*
 * Decodes the next `count` bytes of the current entry into `buffer`.
 * Callable repeatedly, so the caller can stop early on an oversized entry.
 * Returns 1 on success, 0 on failure (including a CRC mismatch at the end).
 */
EMSCRIPTEN_KEEPALIVE int cr_entry_read(cr_handle *handle, void *buffer, size_t count)
{
    return ar_entry_uncompress(handle->archive, buffer, count) ? 1 : 0;
}

/*
 * For an archive that was encrypted and has been decrypted (see
 * public/vendor/sevenzip/decrypt-rar.mjs): call after an entry has been
 * read to its end, before cr_next().
 *
 * RAR pads each entry's packed data to the cipher's block size before
 * encrypting it, and decrypting leaves that padding in place: nothing in
 * the archive says how long the data really was. In a solid archive that
 * matters. unarr reads a few bytes ahead, and at the start of the next
 * entry of a solid archive it carries over what it had read ahead and not
 * used, which here is padding, and decodes it as the start of that entry.
 * RAR's own unpacker starts every entry with an empty input buffer; this
 * makes unarr do the same.
 *
 * By this point unarr has, in all but a freak case, already read the marker
 * that ends the entry's data (it decodes ahead until it meets one). The
 * freak case is an entry whose last byte falls exactly where one of the
 * decoder's working windows ends; the marker is then lost with the rest,
 * and the entries after it fail their checksums.
 */
EMSCRIPTEN_KEEPALIVE void cr_entry_finish(cr_handle *handle)
{
    ar_archive_rar *rar = (ar_archive_rar *)handle->archive;

    rar->uncomp.br.available = 0;
    rar->uncomp.br.bits = 0;
}

EMSCRIPTEN_KEEPALIVE void cr_close(cr_handle *handle)
{
    if (!handle)
        return;
    ar_close_archive(handle->archive);
    ar_close(handle->stream);
    free(handle);
}
