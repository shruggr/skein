/* skein: WASI preview1 has no processes; waitpid always fails (ECHILD). */
#ifndef SKEIN_SYS_WAIT_H
#define SKEIN_SYS_WAIT_H
#include <sys/types.h>
#define WNOHANG 1
#define WUNTRACED 2
#ifndef WEXITSTATUS
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#define WTERMSIG(s) ((s) & 0x7f)
#define WIFEXITED(s) (!WTERMSIG(s))
#define WIFSIGNALED(s) (((s) & 0xffff) - 1U < 0xffu)
#endif
pid_t waitpid(pid_t pid, int *status, int options);
pid_t wait(int *status);
#endif
