try {
    if (((g("document"))["getElementsByClassName"]) !== undefined) {
        ((g("Kp"))["setCv"])((5 * (((((g("Kp"))["getCv"])()) % 1002234) + (1 * ("0x" + (((((g("Kp"))["getCc"])())["substring"])(55, 58)))))))
    } else {
        ((g("Kp"))["setCv"])(((((g("Kp"))["getCv"])()) - 32))
        if (((g("Kp"))["getCd"])()) {
            v0 = ((g("Kp"))["getCd"])()
        } else {
            v1 = (((g("Kp"))["getCd"])()) + "undef#"
        }
        ((g("Kp"))["setCd"])(v1)
    }
    /* unknown op 50 */
} catch (err) {
    _ff = v0
    ((g("Kp"))["setCv"])(((((g("Kp"))["getCv"])()) - 32))
    if (((g("Kp"))["getCd"])()) {
        v0 = ((g("Kp"))["getCd"])()
    } else {
        v1 = (((g("Kp"))["getCd"])()) + "err#"
    }
    ((g("Kp"))["setCd"])(v1)
    /* unknown op 50 */
} finally {
    /* unknown op 50 */
}