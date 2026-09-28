// The components unit test's program (issue #34, component_test.zig): one C
// source built three ways by build.sh — a preview1 module, that module made a
// component through the preview1 adapter, and a native WASI 0.2 component
// (wasi-sdk's wasm32-wasip2: wasi-libc on wasi:filesystem/io/cli directly).
// All three must print the same thing and leave the same tree.
//
//   probe fs        the filesystem, stdio, args, env, clock and random
//   probe spin N    N iterations of arithmetic (fuel)
//   probe forever   never ends (out of fuel)
//   probe exit N    exit status N
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/random.h>
#include <time.h>
#include <unistd.h>

static void line(const char *what, int r) {
  printf("%s: %d%s%s\n", what, r, r < 0 ? " " : "", r < 0 ? strerror(errno) : "");
}

static int names(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static void list(const char *dir) {
  DIR *d = opendir(dir);
  if (!d) { printf("opendir %s: %s\n", dir, strerror(errno)); return; }
  char *n[64];
  int k = 0;
  struct dirent *e;
  while ((e = readdir(d)) && k < 64) n[k++] = strdup(e->d_name);
  closedir(d);
  qsort(n, k, sizeof n[0], names);
  printf("%s:", dir);
  for (int i = 0; i < k; i++) {
    struct stat st;
    char p[256];
    snprintf(p, sizeof p, "%s/%s", dir, n[i]);
    if (lstat(p, &st) == 0) printf(" %s(%s,%lld)", n[i], S_ISDIR(st.st_mode) ? "d" : S_ISLNK(st.st_mode) ? "l" : "f", (long long)st.st_size);
    else printf(" %s(?)", n[i]);
  }
  printf("\n");
}

static void fs(int argc, char **argv) {
  for (int i = 0; i < argc; i++) printf("arg %d: %s\n", i, argv[i]);
  const char *v = getenv("PROBE");
  printf("env PROBE=%s\n", v ? v : "(unset)");
  char in[64] = {0};
  ssize_t n = read(0, in, sizeof in - 1);
  printf("stdin: %zd \"%s\"\n", n, n > 0 ? in : "");

  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  printf("time: %lld.%09ld\n", (long long)ts.tv_sec, ts.tv_nsec);
  unsigned char r[8];
  getentropy(r, sizeof r);
  printf("random:");
  for (int i = 0; i < 8; i++) printf(" %02x", r[i]);
  printf("\n");

  line("mkdir d", mkdir("d", 0755));
  line("mkdir d again", mkdir("d", 0755));
  FILE *f = fopen("d/a.txt", "w");
  fputs("hello\n", f);
  fclose(f);
  f = fopen("d/a.txt", "a");
  fputs("more\n", f);
  fclose(f);
  char buf[64] = {0};
  int fd = open("d/a.txt", O_RDONLY);
  n = read(fd, buf, sizeof buf - 1);
  printf("read: %zd \"%s\"\n", n, buf);
  line("lseek", (int)lseek(fd, 2, SEEK_SET));
  memset(buf, 0, sizeof buf);
  n = read(fd, buf, 3);
  printf("read at 2: %zd \"%s\"\n", n, buf);
  close(fd);
  line("rename", rename("d/a.txt", "d/b.txt"));
  line("symlink", symlink("b.txt", "d/l"));
  char t[64] = {0};
  n = readlink("d/l", t, sizeof t - 1);
  printf("readlink: %zd %s\n", n, t);
  line("link", link("d/b.txt", "d/h.txt"));
  line("truncate", truncate("d/h.txt", 3));
  line("open missing", open("nope/x", O_RDONLY));
  line("rmdir non-empty", rmdir("d"));
  line("unlink dir", unlink("d"));
  line("mkdir e", mkdir("d/e", 0755));
  line("rmdir e", rmdir("d/e"));
  list(".");
  list("d");
  struct stat st;
  line("stat a.txt", stat("a.txt", &st));
  printf("a.txt size %lld ino %llu\n", (long long)st.st_size, (unsigned long long)st.st_ino);
  line("stat d/l", stat("d/l", &st));
  printf("d/l size %lld\n", (long long)st.st_size);
  line("unlink d/l", unlink("d/l"));
  fprintf(stderr, "to stderr\n");
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "fs")) { fs(argc, argv); return 0; }
  if (argc > 2 && !strcmp(argv[1], "spin")) {
    long n = atol(argv[2]);
    volatile unsigned long s = 0;
    for (long i = 0; i < n; i++) s = s * 31 + (unsigned long)i;
    printf("spin %ld: %lu\n", n, s);
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "forever")) {
    volatile unsigned long s = 0;
    for (;;) s++;
  }
  if (argc > 2 && !strcmp(argv[1], "exit")) return atoi(argv[2]);
  fprintf(stderr, "usage: probe fs|spin N|forever|exit N\n");
  return 2;
}
