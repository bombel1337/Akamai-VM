try {
    if (((g("document"))["removeChild"]) !== undefined) {
        ((g("nz"))["setCv"])((3 * (((((g("nz"))["getCv"])()) % 1221234) + (4 * (5 + (1 * ("0x" + (((((g("nz"))["getCc"])())["substring"])(60, 62)))))))))
    } else {
        ((g("nz"))["setCv"])(((((g("nz"))["getCv"])()) * 87))
        if (((g("nz"))["getCd"])()) {
            v0 = ((g("nz"))["getCd"])()
        } else {
            v1 = (((g("nz"))["getCd"])()) + "undef#"
        }
        ((g("nz"))["setCd"])(v1)
    }
    /* unknown op 50 */
} catch (err) {
    _AX = v0
    ((g("nz"))["setCv"])(((((g("nz"))["getCv"])()) * 87))
    if (((g("nz"))["getCd"])()) {
        v0 = ((g("nz"))["getCd"])()
    } else {
        v1 = (((g("nz"))["getCd"])()) + "err#"
    }
    ((g("nz"))["setCd"])(v1)
    /* unknown op 50 */
} finally {
    /* unknown op 50 */
}