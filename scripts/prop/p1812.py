"""ITU-R P.1812-7：30 MHz–6 GHz 地面点对点路径预测（陆地路径）。

用于**超短波链路可行性判据**（A 到 B 能否通），见 05 方案 6.8。

实现的部分
----------
- §4.2   自由空间基本传输损耗 Lbfs
- §4.3   绕射损耗 Ld —— Delta-Bullington 法（附件 4 §4.2）
         · Bullington 等效刃形（实际地形剖面）
         · Bullington 等效刃形（平滑地面剖面）
         · 球面地绕射 Ldft 一阶项法（P.526-15 §4.2.2.1）
         · Ld = Lbulla + max(Lsph − Lbulls, 0)
- 附件 A 平滑地面高度拟合、有效天线高度 hte/hre、地平角与地平距离
- §4.7   地物（杂波）损耗 —— 代表性地物高度模型
- §4.9   位置变异性 σL（p=50% 时为 0，接口留出）

**未实现的部分（调用方必须知道）**
-----------------------------------
- §4.4 对流层散射 Lbs —— 本项目规划区 ≤120 km，散射项在此距离上不会成为
  主导；超过约 200 km 的路径本模块会低估损耗。
- §4.5 波导/层反射 Lba —— 仅在时间百分比 p ≪ 50% 时显著，本项目取中值 p=50%。
- §4.6 上述两项与绕射项的混合公式 —— 因上两项未实现，本模块直接取
  Lb = Lbfs + Ld，相当于 P.1812 在「中值、陆地、短路径」条件下的退化形式。
- §4.8 建筑物入损 —— 室外场景不涉及。
- 时间变异性（p≠50%）—— 接口留出 `p` 参数但仅接受 50。

也就是说：**绕射物理是真的，时间/散射统计没有做。** 用于本项目
120 km 陆地路径的中值预测是成立的；要给出时间可用度或超视距散射结论时不成立。

单位约定：距离 km、高度 m、频率 GHz（与 P.1812 原文一致，与本项目
kHz/m 的对外口径在 `propagation.py` 门面层转换）。
"""
import math

# 标准大气折射：ΔN = 45 N-units/km（P.1812 §3.2 中纬度典型值）
DELTA_N_DEFAULT = 45.0
RE_KM = 6371.0


def effective_earth_radius_km(delta_n=DELTA_N_DEFAULT):
    """P.1812 §4.1：中值等效地球半径 ae。ΔN=45 时 ae≈8493 km（k≈1.333）。"""
    k50 = 157.0 / (157.0 - delta_n)
    return RE_KM * k50


def j_nu(nu):
    """P.526 单刃绕射 J(ν)。ν≤−0.78 时返回 0。

    ν=0 时应为 6.02 dB —— 这是本函数的自检基准。
    """
    if nu <= -0.78:
        return 0.0
    return 6.9 + 20.0 * math.log10(math.sqrt((nu - 0.1) ** 2 + 1.0) + nu - 0.1)


# ---------------------------------------------------------------- 地形剖面处理

def smooth_earth(d, h, hts, hrs):
    """P.452/P.1812 附件 A：由地形剖面拟合平滑地面，给出绕射用有效天线高度。

    参数
        d   剖面距离数组 km，d[0]=0，递增
        h   剖面地面高程数组 m（海拔）
        hts 发射天线海拔高度 m（地面高程 + 挂高）
        hrs 接收天线海拔高度 m
    返回
        (hstd, hsrd, hte, hre)
        hstd/hsrd 为绕射用平滑地面两端高度，hte/hre 为绕射用有效天线高度。
    """
    n = len(d)
    dtot = d[-1]

    # 最小二乘拟合平滑地面（原文 v1 / v2 两个累加式）
    v1 = 0.0
    v2 = 0.0
    for i in range(1, n):
        dd = d[i] - d[i - 1]
        v1 += dd * (h[i] + h[i - 1])
        v2 += dd * (h[i] * (2.0 * d[i] + d[i - 1]) + h[i - 1] * (d[i] + 2.0 * d[i - 1]))
    hst = (2.0 * v1 * dtot - v2) / (dtot ** 2)
    hsr = (v2 - v1 * dtot) / (dtot ** 2)

    # 用地形对视线的最大超出量把平滑地面压下去，保证它不穿过实际地形
    hobs = -1e30
    a_obt = -1e30
    a_obr = -1e30
    for i in range(1, n - 1):
        hh = h[i] - (hts * (dtot - d[i]) + hrs * d[i]) / dtot
        if hh > hobs:
            hobs = hh
        if hh / d[i] > a_obt:
            a_obt = hh / d[i]
        if hh / (dtot - d[i]) > a_obr:
            a_obr = hh / (dtot - d[i])

    if hobs <= 0.0:
        hstp, hsrp = hst, hsr
    else:
        gt = a_obt / (a_obt + a_obr)
        gr = a_obr / (a_obt + a_obr)
        hstp = hst - hobs * gt
        hsrp = hsr - hobs * gr

    hstd = min(hstp, h[0])
    hsrd = min(hsrp, h[-1])
    return hstd, hsrd, hts - hstd, hrs - hsrd


def horizon(d, h, hts, hrs, ae):
    """P.1812 附件 A：地平角与地平距离，并判定路径是否通视。

    返回 (是否通视, theta_t mrad, theta_r mrad, dlt km, dlr km)
    """
    n = len(d)
    dtot = d[-1]
    # 各中间点相对发射端的仰角（mrad），含等效地球曲率
    theta_max = -1e30
    dlt = d[1] if n > 2 else dtot
    for i in range(1, n - 1):
        t = 1000.0 * math.atan((h[i] - hts) / (1000.0 * d[i])
                               - d[i] / (2.0 * ae))
        if t > theta_max:
            theta_max = t
            dlt = d[i]
    theta_td = 1000.0 * math.atan((hrs - hts) / (1000.0 * dtot) - dtot / (2.0 * ae))
    los = theta_max < theta_td

    if los:
        # 通视路径：地平点取菲涅尔遮挡最严重处（原文 §A.2）
        nu_max = -1e30
        dlt = d[1] if n > 2 else dtot
        for i in range(1, n - 1):
            nu = ((h[i] + 500.0 * d[i] * (dtot - d[i]) / ae
                   - (hts * (dtot - d[i]) + hrs * d[i]) / dtot)
                  * math.sqrt(0.002 * dtot / (d[i] * (dtot - d[i]))))
            if nu > nu_max:
                nu_max = nu
                dlt = d[i]
        dlr = dtot - dlt
        theta_t = theta_td
        theta_r = 1000.0 * math.atan((hts - hrs) / (1000.0 * dtot) - dtot / (2.0 * ae))
    else:
        theta_t = theta_max
        theta_rmax = -1e30
        dlr = dtot - d[-2] if n > 2 else dtot
        for i in range(1, n - 1):
            t = 1000.0 * math.atan((h[i] - hrs) / (1000.0 * (dtot - d[i]))
                                   - (dtot - d[i]) / (2.0 * ae))
            if t > theta_rmax:
                theta_rmax = t
                dlr = dtot - d[i]
        theta_r = theta_rmax
    return los, theta_t, theta_r, dlt, dlr


# ---------------------------------------------------------------- 绕射

def bullington(d, h, hts, hrs, ae, f_ghz):
    """P.1812 附件 4 §4.2.1：Bullington 等效刃形绕射损耗（dB）。

    d/h 为剖面，hts/hrs 为两端天线海拔高度，ae 为等效地球半径 km。
    """
    dtot = d[-1]
    lam = 0.2998 / f_ghz          # 波长 m
    ce = 1.0 / ae                 # 等效地球曲率 km^-1

    # 发射端看出去的最大地形斜率
    stim = -1e30
    for i in range(1, len(d) - 1):
        s = (h[i] + 500.0 * ce * d[i] * (dtot - d[i]) - hts) / d[i]
        if s > stim:
            stim = s
    str_ = (hrs - hts) / dtot

    if stim < str_:
        # 视线未被地形切断：取剖面上菲涅尔参数最大的点作等效刃形
        nu_max = -1e30
        for i in range(1, len(d) - 1):
            nu = ((h[i] + 500.0 * ce * d[i] * (dtot - d[i])
                   - (hts * (dtot - d[i]) + hrs * d[i]) / dtot)
                  * math.sqrt(0.002 * dtot / (lam * d[i] * (dtot - d[i]))))
            if nu > nu_max:
                nu_max = nu
        luc = j_nu(nu_max)
    else:
        # 视线被切断：两端最大斜率相交处即等效刃形位置
        srim = -1e30
        for i in range(1, len(d) - 1):
            s = (h[i] + 500.0 * ce * d[i] * (dtot - d[i]) - hrs) / (dtot - d[i])
            if s > srim:
                srim = s
        dbp = (hrs - hts + srim * dtot) / (stim + srim)
        nu = ((hts + stim * dbp - (hts * (dtot - dbp) + hrs * dbp) / dtot)
              * math.sqrt(0.002 * dtot / (lam * dbp * (dtot - dbp))))
        luc = j_nu(nu)

    # 原文的经验修正项，使等效刃形结果向实测靠拢
    return luc + (1.0 - math.exp(-luc / 6.0)) * (10.0 + 0.02 * dtot)


def _ldft_single(d_km, hte, hre, adft, f_ghz, eps_r, sigma, pol="v"):
    """P.526-15 §4.2.2.1 一阶项法球面地绕射（单一地质条件）。"""
    # 归一化地面导纳 K
    if pol.lower().startswith("h"):
        k = 0.36 * (adft * f_ghz) ** (-1.0 / 3.0) * \
            ((eps_r - 1.0) ** 2 + (18.0 * sigma / f_ghz) ** 2) ** (-0.25)
    else:
        kh = 0.36 * (adft * f_ghz) ** (-1.0 / 3.0) * \
            ((eps_r - 1.0) ** 2 + (18.0 * sigma / f_ghz) ** 2) ** (-0.25)
        k = kh * math.sqrt(eps_r ** 2 + (18.0 * sigma / f_ghz) ** 2)

    beta = (1.0 + 1.6 * k ** 2 + 0.67 * k ** 4) / \
           (1.0 + 4.5 * k ** 2 + 1.53 * k ** 4)

    x = 21.88 * beta * (f_ghz / adft ** 2) ** (1.0 / 3.0) * d_km

    def g(h_m):
        y = 0.9575 * beta * (f_ghz ** 2 / adft) ** (1.0 / 3.0) * h_m
        b = beta * y
        if b > 2.0:
            gv = 17.6 * math.sqrt(b - 1.1) - 5.0 * math.log10(b - 1.1) - 8.0
        else:
            gv = 20.0 * math.log10(b + 0.1 * b ** 3)
        floor = 2.0 + 20.0 * math.log10(k)
        return max(gv, floor)

    if x >= 1.6:
        fx = 11.0 + 10.0 * math.log10(x) - 17.6 * x
    else:
        fx = -20.0 * math.log10(x) - 5.6488 * x ** 1.425

    return -fx - g(hte) - g(hre)


def ldft(d_km, hte, hre, adft, f_ghz, omega=0.0, pol="v"):
    """球面地绕射损耗（一阶项法），按海陆比例 ω 在两组地质参数间插值。

    陆地 εr=22 σ=0.003 S/m；海面 εr=80 σ=5 S/m（P.1812 §4.3.3）。
    本项目规划区为内陆，ω 恒为 0。
    """
    ld_land = _ldft_single(d_km, hte, hre, adft, f_ghz, 22.0, 0.003, pol)
    if omega <= 0.0:
        return ld_land
    ld_sea = _ldft_single(d_km, hte, hre, adft, f_ghz, 80.0, 5.0, pol)
    return omega * ld_sea + (1.0 - omega) * ld_land


def spherical_diffraction(d_km, hte, hre, ap, f_ghz, omega=0.0, pol="v"):
    """P.452-16 附件 3 / P.526 §4.2：球面地绕射损耗 Ldsph（dB）。

    一阶项法只在**超出球面地视距**时直接适用。视距之内要先判余隙：
    余隙够则无绕射损耗，不够则按余隙比例折算。缺了这一步会把
    近距离视距路径也算成绕射受限，短链路的损耗会被严重高估。
    """
    hte = max(hte, 0.01)
    hre = max(hre, 0.01)
    lam = 0.2998 / f_ghz
    dlos = math.sqrt(2.0 * ap) * (math.sqrt(0.001 * hte) + math.sqrt(0.001 * hre))
    if d_km >= dlos:
        return ldft(d_km, hte, hre, ap, f_ghz, omega, pol)

    # 视距之内：求球面地上两个「等效反射点」距离，再求最小余隙 hse
    c = (hte - hre) / (hte + hre)
    m = 250.0 * d_km * d_km / (ap * (hte + hre))
    arg = (3.0 * c / 2.0) * math.sqrt(3.0 * m / (m + 1.0) ** 3)
    arg = max(-1.0, min(1.0, arg))
    b = 2.0 * math.sqrt((m + 1.0) / (3.0 * m)) * \
        math.cos(math.pi / 3.0 + math.acos(arg) / 3.0)
    dse1 = d_km / 2.0 * (1.0 + b)
    dse2 = d_km - dse1
    hse = ((hte - 500.0 * dse1 ** 2 / ap) * dse2 +
           (hre - 500.0 * dse2 ** 2 / ap) * dse1) / d_km
    hreq = 17.456 * math.sqrt(dse1 * dse2 * lam / d_km)
    if hse > hreq:
        return 0.0

    # 余隙不足：用「刚好擦过」的修正地球半径算一阶项，再按余隙比例折算
    aem = 500.0 * (d_km / (math.sqrt(hte) + math.sqrt(hre))) ** 2
    ld = ldft(d_km, hte, hre, aem, f_ghz, omega, pol)
    if ld < 0.0:
        return 0.0
    return (1.0 - hse / hreq) * ld


def delta_bullington(d, h, hts, hrs, ae, f_ghz, omega=0.0, pol="v"):
    """P.1812 附件 4 §4.2：Delta-Bullington 绕射损耗（dB）。

    Ld = Lbulla + max(Lsph − Lbulls, 0)
      Lbulla 实际剖面的 Bullington 损耗
      Lbulls 平滑地面剖面的 Bullington 损耗（同样的天线相对高度）
      Lsph   球面地绕射损耗
    这样既保留了真实地形的绕射，又在地形平坦时自然退化为球面地结果。
    """
    dtot = d[-1]
    lbulla = bullington(d, h, hts, hrs, ae, f_ghz)

    hstd, hsrd, hte, hre = smooth_earth(d, h, hts, hrs)
    # 平滑剖面：地面全为 0，两端天线取有效高度
    zeros = [0.0] * len(d)
    lbulls = bullington(d, zeros, hte, hre, ae, f_ghz)

    lsph = spherical_diffraction(dtot, hte, hre, ae, f_ghz, omega, pol)
    return lbulla + max(lsph - lbulls, 0.0), hte, hre


# ---------------------------------------------------------------- 地物损耗

# P.1812 表 4（代表性地物高度 Ha 与距离 dk），按本项目地表覆盖分类映射。
# 「待确认」：地表覆盖分类到 P.1812 地物类别的对应关系由本项目自行确定。
CLUTTER = {
    "水域":     (0.0,  0.0),
    "裸地":     (0.0,  0.0),
    "耕地":     (4.0,  0.1),
    "草地":     (4.0,  0.1),
    "林地":     (15.0, 0.05),
    "山地岩石": (0.0,  0.0),
    "建成区":   (20.0, 0.02),
}


def clutter_loss(h_ant_m, f_ghz, lc):
    """P.1812 §4.7：单端地物（杂波）损耗 Ah（dB）。

    天线高于代表性地物高度时不计损耗。
    """
    ha, dk = CLUTTER.get(lc, (0.0, 0.0))
    if ha <= 0.0 or h_ant_m >= ha:
        return 0.0
    ffc = 0.25 + 0.375 * (1.0 + math.tanh(7.5 * (f_ghz - 0.5)))
    return 10.25 * ffc * math.exp(-dk) * \
        (1.0 - math.tanh(6.0 * (h_ant_m / ha - 0.625))) - 0.33


# ---------------------------------------------------------------- 对外入口

def basic_loss(profile_m, hts_agl, hrs_agl, f_ghz,
               lc_t="耕地", lc_r="耕地", delta_n=DELTA_N_DEFAULT,
               omega=0.0, pol="v", p=50.0):
    """P.1812（中值、陆地、≤200 km）基本传输损耗 Lb（dB）。

    参数
        profile_m  [(距离m, 地面高程m), ...]，首尾即两端位置
        hts_agl    发射天线离地高度 m
        hrs_agl    接收天线离地高度 m
        f_ghz      频率 GHz
        lc_t/lc_r  两端地表覆盖分类（用于地物损耗）
        p          时间百分比，本实现仅支持 50

    返回 (Lb, 明细 dict)
    """
    if abs(p - 50.0) > 1e-9:
        raise ValueError("本实现仅支持中值 p=50%%，时间变异性未实现（见模块文件头）")

    d = [x[0] / 1000.0 for x in profile_m]
    h = [x[1] for x in profile_m]
    dtot = d[-1]
    if dtot < 1e-6:
        return 0.0, {"d_km": 0.0}

    hts = h[0] + hts_agl
    hrs = h[-1] + hrs_agl
    ae = effective_earth_radius_km(delta_n)

    lbfs = 92.44 + 20.0 * math.log10(f_ghz) + 20.0 * math.log10(dtot)
    ld, hte, hre = delta_bullington(d, h, hts, hrs, ae, f_ghz, omega, pol)
    aht = clutter_loss(hts_agl, f_ghz, lc_t)
    ahr = clutter_loss(hrs_agl, f_ghz, lc_r)
    los, theta_t, theta_r, dlt, dlr = horizon(d, h, hts, hrs, ae)

    lb = lbfs + ld + aht + ahr
    return lb, {"d_km": dtot, "Lbfs": lbfs, "Ld": ld, "Aht": aht, "Ahr": ahr,
                "hte": hte, "hre": hre, "los": los,
                "theta_t": theta_t, "theta_r": theta_r,
                "dlt": dlt, "dlr": dlr, "ae": ae}


# ---------------------------------------------------------------- 自检

def _self_test():
    print("=" * 70)
    print("P.1812 自检")
    print("=" * 70)

    print("\n[1] 刃形绕射 J(ν)（P.526 近似式，原文声明精度约 1 dB）")
    for nu, want in ((-0.78, 0.0), (0.0, 6.0), (1.0, 14.0), (2.0, 19.0)):
        got = j_nu(nu)
        ok = abs(got - want) < 0.5
        print("    ν=%5.2f  J=%6.2f dB  经典值≈%4.1f  %s"
              % (nu, got, want, "✓" if ok else "✗"))

    print("\n[2] 等效地球半径（P.1812 §4.1：ae = 6371·157/(157−ΔN)）")
    ae = effective_earth_radius_km()
    print("    ΔN=45（中纬度典型值）-> ae=%.0f km，k=%.3f" % (ae, ae / RE_KM))
    print("    对照：k=4/3 对应 ΔN=39，ae=%.0f km"
          % effective_earth_radius_km(39.0))
    print("    注：terrain.los_clearance 的视域几何用的是 k=4/3，"
          "与本模块 ΔN=45 不同源，见文件头「待确认」  ⚠")

    print("\n[3] 平坦地面、两端 30 m、150 MHz：损耗随距离单调增")
    prev, mono = -1e9, True
    for dkm in (5, 10, 20, 40, 60, 80, 100):
        prof = [(i * dkm * 1000.0 / 40, 0.0) for i in range(41)]
        lb, det = basic_loss(prof, 30.0, 30.0, 0.15)
        if det["Ld"] < prev - 1e-9:
            mono = False
        prev = det["Ld"]
        print("    d=%3d km  Lbfs=%6.1f  Ld=%6.1f  Lb=%6.1f  %s"
              % (dkm, det["Lbfs"], det["Ld"], lb,
                 "视距" if det["los"] else "超视距"))
    print("    绕射损耗单调不减：%s" % ("✓" if mono else "✗"))
    print("    球面地视距约 %.0f km（两端 30 m），越过后绕射项迅速上升"
          % (math.sqrt(2 * effective_earth_radius_km()) * 2 * math.sqrt(0.03)))

    print("\n[4] 视距内插入障碍物，损耗必须增加")
    ok4 = True
    for dkm, hill_m in ((10, 100), (20, 200), (30, 300)):
        n = 40
        flat = [(i * dkm * 1000.0 / n, 0.0) for i in range(n + 1)]
        hill = [(i * dkm * 1000.0 / n, hill_m if i == n // 2 else 0.0)
                for i in range(n + 1)]
        lf, _ = basic_loss(flat, 30.0, 30.0, 0.15)
        lh, _ = basic_loss(hill, 30.0, 30.0, 0.15)
        good = lh > lf + 3.0
        ok4 = ok4 and good
        print("    d=%2d km 中点 %3d m 山：平坦 %.1f -> 加山 %.1f dB（+%.1f）%s"
              % (dkm, hill_m, lf, lh, lh - lf, "✓" if good else "✗"))

    print("\n[5] 远距离的「障碍增益」——这是真实物理，不是 bug")
    n = 40
    flat = [(i * 2500.0, 0.0) for i in range(n + 1)]
    hill = [(i * 2500.0, 500.0 if i == n // 2 else 0.0) for i in range(n + 1)]
    lf, df = basic_loss(flat, 30.0, 30.0, 0.15)
    lh, dh = basic_loss(hill, 30.0, 30.0, 0.15)
    print("    100 km 平坦：Lb=%.1f dB（球面地爬行绕射 Ld=%.1f）" % (lf, df["Ld"]))
    print("    100 km 中点 500 m 山：Lb=%.1f dB（刃形绕射 Ld=%.1f）" % (lh, dh["Ld"]))
    print("    山体反而降低 %.1f dB —— 远超视距时刃形绕射优于球面爬行，"
          "教科书称「障碍增益」" % (lf - lh))

    print("\n[6] 自由空间下界：Lb 不得小于 Lbfs")
    ok6 = True
    for dkm in (1, 5, 20, 50, 100):
        prof = [(i * dkm * 1000.0 / 40, 0.0) for i in range(41)]
        lb, det = basic_loss(prof, 30.0, 30.0, 0.15)
        if lb < det["Lbfs"] - 1e-6:
            ok6 = False
    print("    %s" % ("✓" if ok6 else "✗"))

    print("\n[7] 地物损耗：天线高于地物为 0，低于为正")
    for ha, lc in ((2.0, "林地"), (30.0, "林地"), (2.0, "耕地"), (2.0, "水域")):
        print("    挂高 %4.1f m  %-4s  Ah=%.2f dB" % (ha, lc, clutter_loss(ha, 0.15, lc)))

    print("=" * 70)
    print("结论：%s" % ("全部通过" if (mono and ok4 and ok6) else "有未通过项，见上"))
    print("=" * 70)


if __name__ == "__main__":
    _self_test()
