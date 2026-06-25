try {
    if ((g("MouseEvent")) !== undefined) {
        ((g("Kp"))["setCv"])((3 * (((((((((g("Kp"))["getCv"])()) % 1031234) + 5) - (1 * ("0x" + (((((g("Kp"))["getCc"])())["substring"])(37, 39))))) + (1 * (((((g("Kp"))["getCgs"])())["slice"])(10, 11)))) + 27) + (1 * (((((g("Kp"))["getCgs"])())["slice"])(11, 12))))))
    } else {
        ((g("Kp"))["setCv"])(((((g("Kp"))["getCv"])()) + 219))
        if (((g("Kp"))["getCd"])()) {
            v0 = ((g("Kp"))["getCd"])()
        } else {
            v1 = (((g("Kp"))["getCd"])()) + "undef#"
        }
        ((g("Kp"))["setCd"])(v1)
    }
    /* unknown op 50 */
} catch (err) {
    _Gq = v0
    ((g("Kp"))["setCv"])(((((g("Kp"))["getCv"])()) + 219))
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