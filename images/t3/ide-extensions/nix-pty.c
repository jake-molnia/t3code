/* gVisor returns EIO when Nix reads a PTY master before its builder opens the
 * slave. Linux blocks that first read. Retry only this initial handshake;
 * subsequent EIO/EOF must retain normal terminal-close semantics. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>
#include <stddef.h>
#include <time.h>
#include <unistd.h>

#define FD_LIMIT 65536
static _Atomic unsigned char awaiting_slave[FD_LIMIT];

int posix_openpt(int flags) {
    int (*original)(int) = dlsym(RTLD_NEXT, "posix_openpt");
    int fd = original(flags);
    if (fd >= 0 && fd < FD_LIMIT) awaiting_slave[fd] = 1;
    return fd;
}

ssize_t read(int fd, void *buffer, size_t count) {
    ssize_t (*original)(int, void *, size_t) = dlsym(RTLD_NEXT, "read");
    ssize_t result = original(fd, buffer, count);
    if (fd < 0 || fd >= FD_LIMIT || !awaiting_slave[fd] || count == 0) return result;
    for (int attempt = 0; result < 0 && errno == EIO && attempt < 5000; attempt++) {
        struct timespec delay = { .tv_sec = 0, .tv_nsec = 1000000 };
        nanosleep(&delay, NULL);
        result = original(fd, buffer, count);
    }
    if (result >= 0) awaiting_slave[fd] = 0;
    return result;
}

int close(int fd) {
    int (*original)(int) = dlsym(RTLD_NEXT, "close");
    if (fd >= 0 && fd < FD_LIMIT) awaiting_slave[fd] = 0;
    return original(fd);
}
