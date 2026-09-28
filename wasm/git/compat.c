/*
 * skein: definitions behind wasi-compat.h and the stub headers in include/.
 * git built for wasm32-wasip1 runs as one process with no children: every
 * process, signal, user, terminal and socket call either fails as it would on
 * a system without the facility or does nothing. Temporary files are made
 * with names from getentropy(), which under skein is the run's deterministic
 * random stream.
 */
#include "wasi-compat.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/stat.h>
#include "netdb.h"
#include "pwd.h"
#include "grp.h"
#include "termios.h"
#include "sys/wait.h"

/*
 * wasi-libc starts every program in "/"; the skein shell hands a child its
 * working directory as $PWD (as brush and coreutils are patched to read it).
 */
__attribute__((constructor)) static void skein_chdir_pwd(void)
{
	const char *pwd = getenv("PWD");
	if (pwd && *pwd == '/')
		chdir(pwd);
}

pid_t fork(void) { errno = ENOSYS; return -1; }
int execv(const char *p, char *const a[]) { (void)p; (void)a; errno = ENOSYS; return -1; }
int execve(const char *p, char *const a[], char *const e[]) { (void)p; (void)a; (void)e; errno = ENOSYS; return -1; }
int execvp(const char *f, char *const a[]) { (void)f; (void)a; errno = ENOSYS; return -1; }
int execl(const char *p, const char *a, ...) { (void)p; (void)a; errno = ENOSYS; return -1; }
int execlp(const char *f, const char *a, ...) { (void)f; (void)a; errno = ENOSYS; return -1; }
__attribute__((import_module("skein"), import_name("pipe")))
int __skein_host_pipe(unsigned *fds);
__attribute__((import_module("skein"), import_name("spawn")))
int __skein_host_spawn(const char *req, size_t len, int in, int out, int err, int *code);

int skein_pipe(int fds[2])
{
	unsigned f[2];
	int e = __skein_host_pipe(f);
	if (e) { errno = e; return -1; }
	fds[0] = (int)f[0];
	fds[1] = (int)f[1];
	return 0;
}

/* Children: a spawn request kept until waited for (deferred), or a status. */
struct child {
	pid_t pid;
	int done, status;
	char *req;
	size_t len;
	int in, out, err;
};
static struct child children[32];
static pid_t next_pid = 2;

static void put(char **buf, size_t *len, size_t *cap, const char *s)
{
	size_t n = strlen(s) + 1;
	if (*len + n > *cap) {
		*cap = (*len + n) * 2;
		*buf = realloc(*buf, *cap);
	}
	memcpy(*buf + *len, s, n);
	*len += n;
}

static int run_child(struct child *c)
{
	int code = 0;
	int e = __skein_host_spawn(c->req, c->len, c->in, c->out, c->err, &code);
	free(c->req);
	c->req = NULL;
	c->done = 1;
	if (e) {
		/* not a program the shell has: exec's ENOENT, as a shell reports it */
		c->status = (e == ENOENT ? 127 : 126) << 8;
		errno = e;
		return -1;
	}
	c->status = (code & 0xff) << 8;
	return 0;
}

pid_t skein_spawn(const char **argv, const char **env, const char *dir,
		  int fd_in, int fd_out, int fd_err, int defer)
{
	char *buf = NULL, num[16], cwd[4096];
	size_t len = 0, cap = 0;
	int argc = 0, envc = 0, i;
	struct child *c = NULL;
	const char *prog = argv[0];

	for (i = 0; i < (int)(sizeof(children) / sizeof(*children)); i++)
		if (!children[i].pid) { c = &children[i]; break; }
	if (!c) { errno = EAGAIN; return -1; }

	/* the child's cwd: dir (relative to ours) or ours */
	if (!getcwd(cwd, sizeof(cwd))) return -1;
	if (dir && *dir == '/') {
		if (strlen(dir) >= sizeof(cwd)) { errno = ENAMETOOLONG; return -1; }
		strcpy(cwd, dir);
	} else if (dir && *dir) {
		if (strlen(cwd) + strlen(dir) + 2 > sizeof(cwd)) { errno = ENAMETOOLONG; return -1; }
		if (strcmp(cwd, "/")) strcat(cwd, "/");
		strcat(cwd, dir);
	}
	/* /bin/sh is the shell's sh, not a file in the tree */
	if (!strcmp(prog, "/bin/sh")) prog = "sh";

	while (argv[argc]) argc++;
	while (env && env[envc]) envc++;
	put(&buf, &len, &cap, prog);
	put(&buf, &len, &cap, cwd);
	snprintf(num, sizeof(num), "%d", argc);
	put(&buf, &len, &cap, num);
	put(&buf, &len, &cap, prog);
	for (i = 1; i < argc; i++) put(&buf, &len, &cap, argv[i]);
	snprintf(num, sizeof(num), "%d", envc);
	put(&buf, &len, &cap, num);
	for (i = 0; i < envc; i++) put(&buf, &len, &cap, env[i]);

	memset(c, 0, sizeof(*c));
	c->pid = next_pid++;
	c->req = buf;
	c->len = len;
	c->in = fd_in;
	c->out = fd_out;
	c->err = fd_err;
	if (!defer && run_child(c) < 0) {
		c->pid = 0;
		return -1;
	}
	return c->pid;
}

pid_t waitpid(pid_t pid, int *status, int options)
{
	int i;
	(void)options;
	for (i = 0; i < (int)(sizeof(children) / sizeof(*children)); i++) {
		struct child *c = &children[i];
		if (!c->pid || (pid > 0 && c->pid != pid)) continue;
		if (!c->done) {
			int in = c->in;
			run_child(c);
			if (in >= 0) close(in);
		}
		if (status) *status = c->status;
		pid = c->pid;
		c->pid = 0;
		return pid;
	}
	errno = ECHILD;
	return -1;
}
pid_t wait(int *status) { return waitpid(-1, status, 0); }
int kill(pid_t pid, int sig) { (void)pid; (void)sig; errno = ESRCH; return -1; }
unsigned alarm(unsigned s) { (void)s; return 0; }
pid_t getppid(void) { return 0; }
pid_t getpgid(pid_t pid) { (void)pid; errno = ENOSYS; return -1; }
pid_t tcgetpgrp(int fd) { (void)fd; errno = ENOTTY; return -1; }
pid_t setsid(void) { errno = ENOSYS; return -1; }

uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void) { return 0; }
gid_t getegid(void) { return 0; }
mode_t umask(mode_t m) { (void)m; return 022; }

int skein_chmod(const char *path, mode_t mode) { struct stat st; (void)mode; return stat(path, &st); }
int skein_fchmod(int fd, mode_t mode) { struct stat st; (void)mode; return fstat(fd, &st); }

struct passwd *getpwuid(uid_t uid) { (void)uid; return NULL; }
struct passwd *getpwnam(const char *name) { (void)name; return NULL; }
struct group *getgrnam(const char *name) { (void)name; return NULL; }
struct group *getgrgid(gid_t gid) { (void)gid; return NULL; }

char *getpass(const char *prompt) { (void)prompt; errno = ENOTTY; return NULL; }
int tcgetattr(int fd, struct termios *t) { (void)fd; (void)t; errno = ENOTTY; return -1; }
int tcsetattr(int fd, int act, const struct termios *t) { (void)fd; (void)act; (void)t; errno = ENOTTY; return -1; }

int sigemptyset(sigset_t *s) { memset(s, 0, sizeof(*s)); return 0; }
int sigfillset(sigset_t *s) { memset(s, 0xff, sizeof(*s)); return 0; }
int sigaddset(sigset_t *s, int n) { (void)s; (void)n; return 0; }
int sigdelset(sigset_t *s, int n) { (void)s; (void)n; return 0; }
int sigismember(const sigset_t *s, int n) { (void)s; (void)n; return 0; }
int sigprocmask(int how, const sigset_t *s, sigset_t *old) { (void)how; (void)s; if (old) memset(old, 0, sizeof(*old)); return 0; }
int sigaction(int sig, const struct sigaction *act, struct sigaction *old)
{
	if (old) memset(old, 0, sizeof(*old));
	if (act && sig != SIGKILL && sig != SIGSTOP) signal(sig, act->sa_handler);
	return 0;
}

int socket(int d, int t, int p) { (void)d; (void)t; (void)p; errno = ENOSYS; return -1; }
int connect(int fd, const struct sockaddr *a, socklen_t l) { (void)fd; (void)a; (void)l; errno = ENOSYS; return -1; }
int bind(int fd, const struct sockaddr *a, socklen_t l) { (void)fd; (void)a; (void)l; errno = ENOSYS; return -1; }
int listen(int fd, int b) { (void)fd; (void)b; errno = ENOSYS; return -1; }
int setsockopt(int fd, int lv, int n, const void *v, socklen_t l) { (void)fd; (void)lv; (void)n; (void)v; (void)l; errno = ENOSYS; return -1; }
int h_errno;
struct servent *getservbyname(const char *n, const char *p) { (void)n; (void)p; return NULL; }
struct hostent *gethostbyname(const char *n) { (void)n; h_errno = 1; return NULL; }
int getaddrinfo(const char *n, const char *s, const struct addrinfo *h, struct addrinfo **r) { (void)n; (void)s; (void)h; *r = NULL; return EAI_NONAME; }
void freeaddrinfo(struct addrinfo *r) { (void)r; }
const char *gai_strerror(int e) { (void)e; return "no network under WASI"; }
int getnameinfo(const struct sockaddr *sa, socklen_t sl, char *h, socklen_t hl, char *s, socklen_t svl, int f) { (void)sa; (void)sl; (void)h; (void)hl; (void)s; (void)svl; (void)f; return EAI_NONAME; }
const char *hstrerror(int e) { (void)e; return "no network under WASI"; }

/* mkstemp & co.: XXXXXX from getentropy(), O_CREAT|O_EXCL, a few tries. */
static int fill_template(char *t, int suffixlen)
{
	static const char letters[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	size_t len = strlen(t);
	unsigned char r[6];
	char *x;
	int i;
	if (suffixlen < 0 || len < 6 + (size_t)suffixlen) { errno = EINVAL; return -1; }
	x = t + len - suffixlen - 6;
	if (memcmp(x, "XXXXXX", 6)) { errno = EINVAL; return -1; }
	if (getentropy(r, sizeof(r))) return -1;
	for (i = 0; i < 6; i++) x[i] = letters[r[i] % 62];
	return 0;
}

int mkstemps(char *t, int suffixlen)
{
	size_t len = strlen(t);
	char *x = len >= 6 + (size_t)suffixlen ? t + len - suffixlen - 6 : NULL;
	int tries;
	for (tries = 0; tries < 100; tries++) {
		int fd;
		if (x) memcpy(x, "XXXXXX", 6);
		if (fill_template(t, suffixlen)) return -1;
		fd = open(t, O_RDWR | O_CREAT | O_EXCL, 0600);
		if (fd >= 0 || errno != EEXIST) return fd;
	}
	errno = EEXIST;
	return -1;
}
int mkstemp(char *t) { return mkstemps(t, 0); }
int mkostemp(char *t, int flags) { (void)flags; return mkstemps(t, 0); }
char *mkdtemp(char *t)
{
	int tries;
	char *x = strlen(t) >= 6 ? t + strlen(t) - 6 : NULL;
	for (tries = 0; tries < 100; tries++) {
		if (x) memcpy(x, "XXXXXX", 6);
		if (fill_template(t, 0)) return NULL;
		if (!mkdir(t, 0700)) return t;
		if (errno != EEXIST) return NULL;
	}
	return NULL;
}
