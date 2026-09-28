/* skein: no terminals under WASI; tcgetattr/tcsetattr fail (ENOTTY). */
#ifndef SKEIN_TERMIOS_H
#define SKEIN_TERMIOS_H
typedef unsigned int tcflag_t;
typedef unsigned char cc_t;
#define NCCS 32
struct termios { tcflag_t c_iflag, c_oflag, c_cflag, c_lflag; cc_t c_cc[NCCS]; };
#define TCSANOW 0
#define TCSAFLUSH 2
#define ECHO 0000010
#define ICANON 0000002
#define ISIG 0000001
#define VMIN 6
#define VTIME 5
int tcgetattr(int fd, struct termios *t);
int tcsetattr(int fd, int act, const struct termios *t);
#endif
