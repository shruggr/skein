/* skein: no network under WASI; git uses these only for remotes (not in scope). */
#ifndef SKEIN_NETDB_H
#define SKEIN_NETDB_H
#include <sys/socket.h>
#include <netinet/in.h>
struct hostent { char *h_name; char **h_aliases; int h_addrtype; int h_length; char **h_addr_list; };
#define h_addr h_addr_list[0]
struct addrinfo { int ai_flags, ai_family, ai_socktype, ai_protocol; socklen_t ai_addrlen; struct sockaddr *ai_addr; char *ai_canonname; struct addrinfo *ai_next; };
#define AI_CANONNAME 0x02
#define AI_PASSIVE 0x01
#define NI_MAXHOST 1025
#define NI_MAXSERV 32
#define NI_NUMERICHOST 0x01
#define NI_NUMERICSERV 0x02
#define EAI_NONAME -2
struct servent { char *s_name; char **s_aliases; int s_port; char *s_proto; };
struct servent *getservbyname(const char *name, const char *proto);
struct hostent *gethostbyname(const char *name);
int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res);
void freeaddrinfo(struct addrinfo *res);
const char *gai_strerror(int errcode);
int getnameinfo(const struct sockaddr *sa, socklen_t salen, char *host, socklen_t hostlen, char *serv, socklen_t servlen, int flags);
extern int h_errno;
const char *hstrerror(int err);
#endif
