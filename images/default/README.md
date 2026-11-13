# The default image

One genesis for everyone, with no root in it (#89, #143). Its rows are the kernel's operations
(`/kernel/objects`, `/kernel/head`, `/kernel/route`, `/kernel/grant`: role root — nobody holds root
yet) and the claim row (`/kernel/claim`, `handler: "kernel.claim"`, role user): the first claim's
sender is granted root and the claim row is removed in the same step. **It has no apps**: root
installs them by its requests after the claim (`skein install <dir>`). An instance born owned (a
host's create with an owner at birth) has root granted in its genesis and no claim row. Nothing is
served at `/` until root routes it. docs/BOOTSTRAP.md, "The default image".
