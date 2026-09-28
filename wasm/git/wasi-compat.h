/*
 * skein: force-included into every git translation unit built for
 * wasm32-wasip1. WASI preview1 has no processes, signals, users, terminals
 * or sockets; wasi-libc leaves those POSIX calls undeclared. They are
 * declared here and defined in compat.c as calls that fail the way a system
 * without the facility fails (fork/exec: ENOSYS, waitpid: ECHILD, kill:
 * ESRCH, sockets: ENOSYS) or as harmless no-ops (signal masks, umask).
 */
#ifndef SKEIN_WASI_COMPAT_H
#define SKEIN_WASI_COMPAT_H

/* compat/posix.h's feature macros, set before any system header. */
#define _XOPEN_SOURCE 600
#define _XOPEN_SOURCE_EXTENDED 1
#define _ALL_SOURCE 1
#define _GNU_SOURCE 1
#define _BSD_SOURCE 1
#define _DEFAULT_SOURCE 1
#define _NETBSD_SOURCE 1
#define _SGI_SOURCE 1

#include <sys/types.h>
#include <signal.h>

/*
 * Child processes through the skein host (imports skein.pipe, skein.spawn,
 * as brush and xargs use them): skein_spawn runs argv[0] — a program the
 * shell knows by name, or "sh" — to completion with stdio bound to this
 * process's fds (-1: /dev/null) and returns a pid for waitpid() to report
 * its exit status. With `defer`, the child reads a pipe this process still
 * has to fill, so it runs at waitpid() instead, and its stdin fd is closed
 * then. pipe() is the host's in-memory pipe (processes run one at a time;
 * an empty pipe reads as end of file).
 */
pid_t skein_spawn(const char **argv, const char **env, const char *dir,
		  int fd_in, int fd_out, int fd_err, int defer);
int skein_pipe(int fds[2]);
#define pipe(f) skein_pipe(f)

/* processes */
pid_t fork(void);
int execv(const char *path, char *const argv[]);
int execve(const char *path, char *const argv[], char *const envp[]);
int execvp(const char *file, char *const argv[]);
int execl(const char *path, const char *arg, ...);
int execlp(const char *file, const char *arg, ...);
int kill(pid_t pid, int sig);
unsigned alarm(unsigned seconds);
pid_t getppid(void);
pid_t getpgid(pid_t pid);
pid_t tcgetpgrp(int fd);
pid_t setsid(void);

/* users: one user, uid/gid 0, as wasi-libc's stat reports for every file */
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);
mode_t umask(mode_t mask);

/*
 * Permission bits: the tree records only "executable or not", and WASI
 * preview1 has no call to set it, so chmod succeeds on an existing file and
 * changes nothing (wasi-libc's fails with ENOSYS, which git treats as fatal
 * when it rewrites config). With NO_TRUSTABLE_FILEMODE git sets
 * core.filemode=false and ignores the bits.
 */
int skein_chmod(const char *path, mode_t mode);
int skein_fchmod(int fd, mode_t mode);
#define chmod(p, m) skein_chmod(p, m)
#define fchmod(f, m) skein_fchmod(f, m)

/* terminals */
char *getpass(const char *prompt);

/* temporary files: wasi-libc omits these ("no temp directories") */
int mkstemp(char *template);
int mkostemp(char *template, int flags);
int mkstemps(char *template, int suffixlen);
char *mkdtemp(char *template);

/* signals: wasi-libc's emulation has signal()/raise() only */
struct sigaction {
	void (*sa_handler)(int);
	sigset_t sa_mask;
	int sa_flags;
};
#ifndef SIG_BLOCK
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif
#define SA_RESTART 0x10000000
#define SA_RESETHAND 0x80000000
int sigemptyset(sigset_t *set);
int sigfillset(sigset_t *set);
int sigaddset(sigset_t *set, int sig);
int sigdelset(sigset_t *set, int sig);
int sigismember(const sigset_t *set, int sig);
int sigprocmask(int how, const sigset_t *set, sigset_t *old);
int sigaction(int sig, const struct sigaction *act, struct sigaction *old);

#ifndef ITIMER_REAL
#define ITIMER_REAL 0
#endif

/* sockets: remotes are out of scope; every call fails */
#include <sys/socket.h>
#ifndef SO_KEEPALIVE
#define SO_KEEPALIVE 9
#endif
int socket(int domain, int type, int protocol);
int connect(int fd, const struct sockaddr *addr, socklen_t len);
int bind(int fd, const struct sockaddr *addr, socklen_t len);
int listen(int fd, int backlog);
int setsockopt(int fd, int level, int name, const void *val, socklen_t len);

#endif
