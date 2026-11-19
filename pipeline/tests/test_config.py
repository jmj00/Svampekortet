from pipeline.config import DENMARK_BBOX, MAX_COORDINATE_UNCERTAINTY_M, in_denmark


def test_bbox_is_well_formed():
    min_lon, min_lat, max_lon, max_lat = DENMARK_BBOX
    assert min_lon < max_lon
    assert min_lat < max_lat
    assert 0 < MAX_COORDINATE_UNCERTAINTY_M < 1_000_000


def test_in_denmark():
    assert in_denmark(9.5, 56.2)  # central Jutland
    assert in_denmark(12.57, 55.68)  # Copenhagen
    assert in_denmark(10.4, 55.4)  # Funen (Odense)
    assert in_denmark(14.9, 55.1)  # Bornholm
    assert not in_denmark(9.5, 60.0)  # too far north
    assert not in_denmark(10.0, 53.5)  # northern Germany, south of the border
    assert not in_denmark(5.0, 56.0)  # out in the North Sea
