try {
    if (((g("document"))["head"]) !== undefined) {
        ((g("SX"))["setCv"])((2 * (((((((g("SX"))["getCv"])()) % 1004234) - 3) + (1 * ("0x" + (((((g("SX"))["getCc"])())["substring"])(48, 50))))) - (1 * ("0x" + (((((g("SX"))["getCc"])())["substring"])(50, 51)))))))
    } else {
        ((g("SX"))["setCv"])(((((g("SX"))["getCv"])()) - 11))
        if (((g("SX"))["getCd"])()) {
            v0 = ((g("SX"))["getCd"])()
        } else {
            v1 = (((g("SX"))["getCd"])()) + "undef#"
        }
        ((g("SX"))["setCd"])(v1)
    }
    /* unknown op 50 */
} catch (err) {
    _pM = v0
    ((g("SX"))["setCv"])(((((g("SX"))["getCv"])()) - 11))
    if (((g("SX"))["getCd"])()) {
        v0 = ((g("SX"))["getCd"])()
    } else {
        v1 = (((g("SX"))["getCd"])()) + "err#"
    }
    ((g("SX"))["setCd"])(v1)
    /* unknown op 50 */
} finally {
    /* unknown op 50 */
}