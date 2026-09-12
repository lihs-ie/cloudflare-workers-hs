module Support.DomainFixtures (epoch) where
import Data.Time (UTCTime (..), fromGregorian)
epoch :: UTCTime
epoch = UTCTime (fromGregorian 2026 1 1) 0
