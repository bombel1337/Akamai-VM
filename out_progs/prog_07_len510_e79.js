try {
    if (((((g("document"))["createElement"])("span"))["nodeName"]) !== undefined) {
        ((g("IJ"))["setCv"])((5 * (((((g("IJ"))["getCv"])()) % 1002234) + (1 * ("0x" + (((((g("IJ"))["getCc"])())["substring"])(55, 58)))))))
    } else {
        ((g("IJ"))["setCv"])(((((g("IJ"))["getCv"])()) - 32))
        if (((g("IJ"))["getCd"])()) {
            v0 = ((g("IJ"))["getCd"])()
        } else {
            v1 = (((g("IJ"))["getCd"])()) + "undef#"
        }
        ((g("IJ"))["setCd"])(v1)
    }
    /* unknown op 50 */
} catch (err) {
    _mf = v0
    ((g("IJ"))["setCv"])(((((g("IJ"))["getCv"])()) - 32))
    if (((g("IJ"))["getCd"])()) {
        v0 = ((g("IJ"))["getCd"])()
    } else {
        v1 = (((g("IJ"))["getCd"])()) + "err#"
    }
    ((g("IJ"))["setCd"])(v1)
    /* unknown op 50 */
} finally {
    /* unknown op 50 */
}