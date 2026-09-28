/* skein: WASI has no syslog; git uses it only in daemon.c (not built in). */
#ifndef SKEIN_SYSLOG_H
#define SKEIN_SYSLOG_H
#define LOG_PID 0x01
#define LOG_DAEMON (3 << 3)
#define LOG_ERR 3
#define LOG_INFO 6
static inline void openlog(const char *i, int o, int f) { (void)i; (void)o; (void)f; }
static inline void syslog(int p, const char *fmt, ...) { (void)p; (void)fmt; }
#endif
