#define LIBARCHIVE_STATIC
// #include "emscripten.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <locale.h>
#include <archive.h>
#include <archive_entry.h>
#define EMSCRIPTEN_KEEPALIVE

/*
 * Changes made for OpenCloud Comic Reader are marked "OpenCloud Comic Reader:"
 * and described in ../README.md. Everything else is libarchive.js 2.0.2's
 * main.c.
 */

/* OpenCloud Comic Reader: the reader archive_open last returned, so the next
   call can free it. libarchive.js's worker opens one per listing and per file
   read and frees only the last. */
static struct archive *cr_current = NULL;

EMSCRIPTEN_KEEPALIVE
const char *get_version(){
  return archive_version_string();
}

EMSCRIPTEN_KEEPALIVE
void *archive_open(const void *buf, size_t size, const char *passphrase, const char *locale){
  struct archive *a;
  int r;
  /* OpenCloud Comic Reader: a locale ending in this asks for zip checksums not
     to be compared (see below). The page's API has no other way to pass an
     option through to here. */
  static const char cr_unchecked[] = "@zip-unchecked";
  char cr_locale[64];
  int cr_skip_zip_checksums = 0;
  size_t cr_length = locale ? strlen(locale) : 0;

  if (cr_length >= sizeof(cr_unchecked) - 1 && cr_length < sizeof(cr_locale) &&
      strcmp(locale + cr_length - (sizeof(cr_unchecked) - 1), cr_unchecked) == 0)
  {
    cr_skip_zip_checksums = 1;
    memcpy(cr_locale, locale, cr_length - (sizeof(cr_unchecked) - 1));
    cr_locale[cr_length - (sizeof(cr_unchecked) - 1)] = 0;
    locale = cr_locale;
  }

  setlocale(LC_ALL, locale);

  /* OpenCloud Comic Reader: the worker is done with the previous reader
     by now. */
  if (cr_current)
  {
    archive_read_free(cr_current);
    cr_current = NULL;
  }

  a = archive_read_new();
  /* OpenCloud Comic Reader: the containers a comic comes in, and no others;
     upstream enables every filter and format (tar, cpio, ISO images, ...). */
  archive_read_support_format_rar(a);
  archive_read_support_format_rar5(a);
  archive_read_support_format_7zip(a);
  archive_read_support_format_zip(a);

  if (passphrase)
  {
    archive_read_add_passphrase(a, passphrase);
  }

  /* OpenCloud Comic Reader: for a zip whose entries were AES-encrypted and have
     been decrypted by the app. The second version of that scheme stores no
     checksum (each entry carries an authentication code instead, which the app
     has checked), so the decrypted zip has none to compare. */
  if (cr_skip_zip_checksums)
  {
    archive_read_set_options(a, "zip:ignorecrc32");
  }

  r = archive_read_open_memory(a, buf, size);
  if (r != ARCHIVE_OK)
  {
    fprintf(stderr, "Memory read error %d\n", r);
    fprintf(stderr, "%s\n", archive_error_string(a));
  }
  cr_current = a; /* OpenCloud Comic Reader */
  return a;
}

EMSCRIPTEN_KEEPALIVE
const void *get_next_entry(void *archive){
  struct archive_entry *entry;
  if (archive_read_next_header(archive, &entry) == ARCHIVE_OK)
  {
    return entry;
  }
  else
  {
    return NULL;
  }
}

EMSCRIPTEN_KEEPALIVE
void *get_filedata(void *archive, size_t buffsize){
  /* OpenCloud Comic Reader: zeroed, so a read shorter than the declared size
     does not hand back whatever the heap held; and checked, which it was
     not. */
  void *buff = calloc(1, buffsize);
  if (!buff) return (void *)-1;
  int read_size = archive_read_data(archive, buff, buffsize);
  /* OpenCloud Comic Reader: read on to the end of the entry. libarchive
     compares an entry's checksum at or after its last data (for RAR, on the
     read that finds nothing left), and upstream, having asked for exactly the
     declared size, did not always get there: a damaged entry came back as if it
     were sound. Not for an entry that declares nothing: there is nothing to
     hand back wrong, and a directory must not be read at all. More data than
     was declared is left alone, as before. */
  if (read_size >= 0 && buffsize > 0)
  {
    char past;
    read_size = archive_read_data(archive, &past, 1);
  }
  if (read_size < 0)
  {
    free(buff); /* OpenCloud Comic Reader: was leaked */
    fprintf(stderr, "Error occured while reading file");
    return (void *)read_size;
  }
  return buff;
}

EMSCRIPTEN_KEEPALIVE
void archive_close(void *archive){
  /* OpenCloud Comic Reader: only the current reader is live; any other handle
     was freed when it was replaced. */
  if (archive != cr_current) return;
  cr_current = NULL;
  int r = archive_read_free(archive);
  if (r != ARCHIVE_OK)
  {
    /* OpenCloud Comic Reader: upstream also printed the error string of the
       reader it had just freed. */
    fprintf(stderr, "Error read free %d\n", r);
  }
}

EMSCRIPTEN_KEEPALIVE
void *start_archive_write(char *filter, char *format, void *buff, size_t buffsize, size_t *outputsize, char *passphrase){
  struct archive *a;
  a = archive_write_new();
  archive_write_add_filter_by_name(a, filter);
  archive_write_set_format_by_name(a, format);

  if(passphrase){
    archive_write_set_passphrase(a, passphrase);
  }

  archive_write_open_memory(a, buff, buffsize, outputsize);
  return a;
}

EMSCRIPTEN_KEEPALIVE
void write_archive_file( void *a, char *pathname, size_t filesize , void *filedata ){
  struct archive_entry *entry;

  entry = archive_entry_new();
  archive_entry_set_pathname(entry, pathname);
  archive_entry_set_size(entry, filesize);
  archive_entry_set_filetype(entry, AE_IFREG);
  archive_entry_set_perm(entry, 0644);
  archive_write_header(a, entry);
  int write_output = archive_write_data(a, filedata, filesize);
  if( write_output != filesize ) {
    fprintf(stderr, "Error occured while writing file, written bytes don't match file size\n");
  }

  archive_entry_free(entry);
}

EMSCRIPTEN_KEEPALIVE
int size_of_size_t(){
  return sizeof(size_t);
}

EMSCRIPTEN_KEEPALIVE
int finish_archive_write(void *a, size_t *outputsize){
  if( archive_write_close(a) != ARCHIVE_OK ){
    return -1;
  }
  
  if( archive_write_free(a) != ARCHIVE_OK ){
    return -1;
  }
  return *outputsize;
}