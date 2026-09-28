# skein: git for wasm32-wasip1 (wasi-sdk). Copied into the source tree as
# config.mak by scripts/build-wasm.sh, which sets SKEIN_WASI_SDK, SKEIN_ZLIB
# and SKEIN_COMPAT (this directory). See wasm/README.md, "git".
CC = $(SKEIN_WASI_SDK)/bin/clang --target=wasm32-wasip1 --sysroot=$(SKEIN_WASI_SDK)/share/wasi-sysroot
AR = $(SKEIN_WASI_SDK)/bin/llvm-ar
RANLIB = $(SKEIN_WASI_SDK)/bin/llvm-ranlib
CFLAGS = -O2 -g0 -ffile-prefix-map=$(CURDIR)=. \
	-I$(SKEIN_ZLIB)/include -I$(SKEIN_COMPAT)/include \
	-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID \
	-include $(SKEIN_COMPAT)/wasi-compat.h
LDFLAGS = -L$(SKEIN_ZLIB)/lib -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -Wl,--strip-all
EXTLIBS = $(SKEIN_COMPAT_OBJ)
# uname_S=WASI etc. are passed on make's command line, so config.mak.uname
# applies no host platform's section.
HAVE_ALLOCA_H = YesPlease
HAVE_GETDELIM = YesPlease
# /etc/gitconfig and $HOME/.gitconfig are read from the tree; no templates
# (git.patch: an empty template_dir means none, silently).
prefix = /usr
template_dir =
NO_RUST = YesPlease
NO_OPENSSL = YesPlease
NO_CURL = YesPlease
NO_EXPAT = YesPlease
NO_PERL = YesPlease
NO_PYTHON = YesPlease
NO_TCLTK = YesPlease
NO_GETTEXT = YesPlease
NO_ICONV = YesPlease
NO_MMAP = YesPlease
NO_PTHREADS = YesPlease
NO_UNIX_SOCKETS = YesPlease
NO_IPV6 = YesPlease
NO_SYMLINK_HEAD = YesPlease
NO_POSIX_GOODIES = UnfortunatelyYes
NO_SETITIMER = YesPlease
NO_STRUCT_ITIMERVAL = YesPlease
NO_TRUSTABLE_FILEMODE = YesPlease
NO_REGEX = YesPlease
NO_NSEC = YesPlease
NO_GITWEB = YesPlease
NO_INSTALL_HARDLINKS = YesPlease
NO_INITGROUPS = YesPlease
NO_GECOS_IN_PWENT = YesPlease
NO_ST_BLOCKS_IN_STRUCT_STAT = YesPlease
NO_FSMONITOR = YesPlease
SKIP_DASHED_BUILT_INS = YesPlease
HAVE_CLOCK_GETTIME = YesPlease
HAVE_CLOCK_MONOTONIC = YesPlease
CSPRNG_METHOD = getentropy
